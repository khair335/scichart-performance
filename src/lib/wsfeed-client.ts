/**
 * wsfeed-client.ts
 *
 * A small, production‑minded WebSocket client for the wsfeed protocol.
 *
 * Goals:
 * - Works in browsers and Node (via wsFactory)
 * - Supports text and binary sample frames
 * - Implements a resume cursor with configurable cursor policy:
 *     - resume:      always resume from lastSeq+1
 *     - from_start:  always start at seq=1 (overrides stored cursor)
 *     - auto:        resume, but auto‑reset if the stored cursor is ahead of server wm_seq
 * - Emits human‑friendly “notices” with stable codes & severity
 * - Provides status + registry snapshots for UI dashboards (status bar/toast/log panel)
 */

// This demo client is intended to compile without pulling in Node typings.
// When used in Node, callers should typically supply `wsFactory`.
//
// We keep a tiny best-effort Node fallback that uses CommonJS `require('ws')`.
// To avoid `@types/node`, we declare these globals as `any`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const Buffer: any;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export class MemoryStorage implements StorageLike {
  private _m = new Map<string, string>();

  getItem(key: string): string | null {
    return this._m.has(key) ? (this._m.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this._m.set(key, String(value));
  }
  removeItem(key: string): void {
    this._m.delete(key);
  }
}

export type WsFeedWireFormat = "text" | "binary" | null;

export type WsFeedStage = "idle" | "connecting" | "history" | "delta" | "live" | "closed" | "error";

export type CursorPolicy = "resume" | "from_start" | "auto";

export interface FeedSample {
  seq: number;
  series_id: string;
  t_ms: number;
  payload: any;
  series_seq?: number;
}

export interface SeriesRegistryRow {
  id: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
  firstMs: number;
  lastMs: number;
  firstSeriesSeq?: number | null;
  lastSeriesSeq?: number | null;
  gaps?: number;
  missed?: number;
}

export type NoticeLevel = "debug" | "info" | "warn" | "error";
export type NoticeKind = "state" | "event";

export interface FeedNotice {
  kind: NoticeKind;
  level: NoticeLevel;
  code: string;
  text: string;
  ts: number;
  details?: Record<string, any>;
}

export interface WsFeedStatus {
  type: "status";
  stage: WsFeedStage;
  url: string;
  cursorPolicy: CursorPolicy;
  lastSeq: number;
  bounds: { minSeq: number; wmSeq: number; ringCapacity: number | null };
  resume: {
    requestedFromSeq: number;
    serverResumeFromSeq: number | null;
    truncated: boolean;
  };
  history: { expected: number; received: number; pct: number };
  delta: { received: number };
  live: { received: number };
  rate: { perSec: number; windowMs: number };
  heartbeatLagMs: number | null;
  registry: { total: number };
  wireFormat: WsFeedWireFormat;
  gaps: {
    global: { gaps: number; missed: number };
    series: { totalSeries: number; totalGaps: number; totalMissed: number };
  };
  decodeErrors: {
    text: number;
    binary: number;
  };
  reconnect: {
    enabled: boolean;
    attempts: number;
    nextDelayMs: number | null;
  };
  ts: number;
}

export interface WsFeedClientOptions {
  url: string;
  wsFactory?: (url: string) => any; // Browser WebSocket or Node 'ws'
  storage?: StorageLike;
  storageKey?: string;
  cursorPolicy?: CursorPolicy;
  statusThrottleMs?: number;
  autoReconnect?: boolean;
  autoReconnectInitialDelayMs?: number;
  autoReconnectMaxDelayMs?: number;

  /** Called with deduplicated samples (global seq). */
  onSamples: (samples: FeedSample[]) => void;

  /** Human‑friendly notices suitable for status bars/toasts/log panels. */
  onNotice?: (notice: FeedNotice) => void;

  /** Raw control messages from server (init_begin/init_complete/heartbeat/test_done/error/echo...). */
  onControl?: (msg: any) => void;

  /** Periodic status snapshot for dashboards. */
  onStatus?: (status: WsFeedStatus) => void;

  /** Registry snapshot when it changes. */
  onRegistry?: (rows: SeriesRegistryRow[]) => void;

  /** Generic event callback for control messages (alternative to onControl). */
  onEvent?: (evt: { type: string; [key: string]: unknown }) => void;
}

type AnyWs = any;

function _nowMs(): number {
  return Date.now();
}

function _safeNumber(x: any, fallback: number): number {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function _instrumentFromSeriesId(seriesId: string): string {
  const s = String(seriesId || "");
  const idx = s.indexOf(":");
  return idx >= 0 ? s.slice(0, idx) : "";
}

function _parseStrategyIdFromSeriesId(seriesId: string): string | null {
  // Expected: <sym>:strategy:<strategy_id>:<kind>
  const parts = String(seriesId || "").split(":");
  if (parts.length >= 4 && parts[1] === "strategy") return parts[2] || null;
  return null;
}

function _defaultWsFactory(url: string): any {
  // Browser
  if (typeof WebSocket !== "undefined") {
    return new WebSocket(url);
  }
  // Node (CommonJS only) – users should usually pass wsFactory explicitly.
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const req: any = typeof require !== "undefined" ? require : null;
    if (req) {
      const WS = req("ws");
      return new WS(url);
    }
  } catch {
    // ignore
  }
  throw new Error("No WebSocket implementation available. Provide wsFactory.");
}

export class WsFeedClient {
  public readonly url: string;
  public ws: AnyWs | null = null;

  public stage: WsFeedStage = "idle";
  public wireFormat: WsFeedWireFormat = null;

  // Cursor
  private _cursorPolicy: CursorPolicy;
  private _cursorSeq: number = 0; // persisted cursor (last accepted seq)
  private _acceptAfterSeq: number = 0; // per-connection dedup floor

  // Handshake info
  private _requestedFromSeq: number = 1;
  private _serverResumeFromSeq: number | null = null;
  private _resumeTruncated: boolean = false;
  private _minSeq: number = 0;
  private _wmSeq: number = 0;
  private _ringCapacity: number | null = null;

  // History accounting
  private _expectedHistory: number = 0;
  private _historyReceived: number = 0;
  private _deltaReceived: number = 0;
  private _liveReceived: number = 0;

  // Heartbeat lag
  public lastHeartbeatLagMs: number | null = null;

  // Decode stats
  private _decodeErrorsText: number = 0;
  private _decodeErrorsBinary: number = 0;
  private _textDecoder: TextDecoder | null = null;

  // Gap detection
  private _gapGlobalGaps: number = 0;
  private _gapGlobalMissing: number = 0;

  // Registry
  private _reg = new Map<string, any>();
  private _regDirty: boolean = false;

  // Status throttling
  private _statusThrottleMs: number;
  private _lastStatusTs: number = 0;
  private _sinceLastStatus: number = 0;

  // Reconnect
  private _autoReconnect: boolean;
  private _autoReconnectInitialDelayMs: number;
  private _autoReconnectMaxDelayMs: number;
  private _reconnectAttempts: number = 0;
  private _reconnectTimer: any = null;
  private _autoReconnectNextDelayMs: number | null = null;

  // Close semantics
  private _closing: boolean = false;
  private _explicitClose: boolean = false;
  private _suppressAutoReconnectOnce: boolean = false;

  // Options/callbacks
  private _wsFactory: (url: string) => any;
  public readonly storage: StorageLike | null;
  public readonly storageKey: string;
  private _onSamples: (samples: FeedSample[]) => void;
  private _onNotice?: (n: FeedNotice) => void;
  private _onControl?: (msg: any) => void;
  private _onStatus?: (s: WsFeedStatus) => void;
  private _onRegistry?: (rows: SeriesRegistryRow[]) => void;
  private _onEvent?: (evt: { type: string; [key: string]: unknown }) => void;

  constructor(opts: WsFeedClientOptions) {
    if (!opts || !opts.url) throw new Error("WsFeedClient: url is required");
    if (!opts.onSamples) throw new Error("WsFeedClient: onSamples is required");

    this.url = String(opts.url);
    this._wsFactory = opts.wsFactory || _defaultWsFactory;

    this.storage = opts.storage || null;
    // Default storage key includes URL so different feeds don't fight.
    this.storageKey = String(opts.storageKey || `wsfeed:last_seq:${this.url}`);

    this._cursorPolicy = opts.cursorPolicy || "auto";

    this._statusThrottleMs = typeof opts.statusThrottleMs === "number" ? opts.statusThrottleMs : 250;
    this._autoReconnect = !!opts.autoReconnect;
    this._autoReconnectInitialDelayMs =
      typeof opts.autoReconnectInitialDelayMs === "number" ? opts.autoReconnectInitialDelayMs : 1000;
    this._autoReconnectMaxDelayMs =
      typeof opts.autoReconnectMaxDelayMs === "number" ? opts.autoReconnectMaxDelayMs : 15000;

    this._onSamples = opts.onSamples;
    this._onNotice = opts.onNotice;
    this._onControl = opts.onControl;
    this._onStatus = opts.onStatus;
    this._onRegistry = opts.onRegistry;
    this._onEvent = opts.onEvent;

    // Load persisted cursor
    this._cursorSeq = this._loadCursor();
    this._acceptAfterSeq = this._cursorSeq;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  getLastSeq(): number {
    return this._cursorSeq;
  }

  /** Set the persisted resume cursor (last accepted seq). */
  setLastSeq(v: number): void {
    const n = Math.max(0, Math.floor(Number(v) || 0));
    this._cursorSeq = n;
    this._acceptAfterSeq = Math.max(this._acceptAfterSeq, n);
    this._persistCursor(n);
    this._emitStatus(true);
  }

  getCursorPolicy(): CursorPolicy {
    return this._cursorPolicy;
  }

  setCursorPolicy(policy: CursorPolicy): void {
    const p = (policy || "auto") as CursorPolicy;
    this._cursorPolicy = p;
    this._notice("state", "info", "CLIENT_CURSOR_POLICY", `Cursor policy set to '${p}'.`, { policy: p });
    this._emitStatus(true);
  }

  /**
   * Reset resume cursor back to 0 so the next connect() can start from seq=1.
   *
   * If you want the reset to be ephemeral, pass {persist:false}.
   */
  resetCursor(options: { persist?: boolean } = {}): void {
    const persist = options.persist !== false;
    this._cursorSeq = 0;
    this._acceptAfterSeq = 0;
    this._requestedFromSeq = 1;
    this._serverResumeFromSeq = null;
    this._resumeTruncated = false;
    if (persist) this._persistCursor(0, true);
    this._notice("event", "info", "CLIENT_CURSOR_RESET", "Resume cursor reset to 0 (next connect starts from seq=1).", {
      persist,
    });
    this._emitStatus(true);
  }

  setAutoReconnect(enabled: boolean): void {
    this._autoReconnect = !!enabled;
    if (!this._autoReconnect) {
      this._clearReconnectTimer();
      this._reconnectAttempts = 0;
      this._autoReconnectNextDelayMs = null;
    }
    this._notice(
      "state",
      "info",
      "CLIENT_AUTORECONNECT",
      `Auto-reconnect ${this._autoReconnect ? "enabled" : "disabled"}.`,
      {
        enabled: this._autoReconnect,
      },
    );
    this._emitStatus(true);
  }

  /** Connect (or reconnect) to the WebSocket feed. */
  connect(): void {
    this._closing = false;
    this._explicitClose = false;
    this._suppressAutoReconnectOnce = false;
    this._clearReconnectTimer();

    this.stage = "connecting";
    this._emitStatus(true);
    this._notice("state", "info", "CLIENT_CONNECTING", "Connecting to feed…", { url: this.url });

    // Close any previous socket defensively
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }

    // For from_start, we intentionally start dedup from 0 for this session.
    // For resume/auto, dedup starts from the persisted cursor.
    this._acceptAfterSeq = this._cursorPolicy === "from_start" ? 0 : this._cursorSeq;

    // Reset per-connection counters
    this._expectedHistory = 0;
    this._historyReceived = 0;
    this._deltaReceived = 0;
    this._liveReceived = 0;
    this._gapGlobalGaps = 0;
    this._gapGlobalMissing = 0;
    this._minSeq = 0;
    this._wmSeq = 0;
    this._ringCapacity = null;
    this._resumeTruncated = false;
    this._serverResumeFromSeq = null;
    this.lastHeartbeatLagMs = null;
    this.wireFormat = null;

    this.ws = this._wsFactory(this.url);

    // In browser, prefer ArrayBuffer for binary frames
    try {
      if (typeof WebSocket !== "undefined" && this.ws instanceof WebSocket) {
        this.ws.binaryType = "arraybuffer";
      }
    } catch {
      // ignore
    }

    const sendResume = () => {
      let fromSeq = 1;
      if (this._cursorPolicy === "resume" || this._cursorPolicy === "auto") {
        fromSeq = Math.max(1, this._cursorSeq + 1);
      } else {
        fromSeq = 1;
      }
      this._requestedFromSeq = fromSeq;
      try {
        this.ws?.send(JSON.stringify({ type: "resume", from_seq: fromSeq }));
      } catch (err) {
        this._notice("event", "error", "CLIENT_SEND_RESUME_FAILED", "Failed to send resume frame to server.", {
          error: String(err),
        });
      }
    };

    // Node 'ws' branch: .on('open'|'message'|'close'|'error')
    if (this.ws && typeof this.ws.on === "function") {
      this.ws.on("open", () => {
        this._notice("state", "info", "CLIENT_CONNECTED", "WebSocket connected.", {});
        sendResume();
      });

      this.ws.on("message", (data: any, isBinary: boolean) => {
        let raw: any = data;
        if (!isBinary) {
          if (typeof data !== "string") {
            // Buffer → string
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const B: any = typeof Buffer !== "undefined" ? Buffer : null;
            if (B && B.isBuffer && B.isBuffer(data)) {
              raw = data.toString("utf8");
            } else if (ArrayBuffer.isView(data)) {
              raw = new TextDecoder("utf-8").decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            }
          }
        }
        void this._handleMessage(raw);
      });

      this.ws.on("close", (code: number, reason: any) => {
        this._handleClose(code, typeof reason === "string" ? reason : "");
      });

      this.ws.on("error", (err: any) => {
        this.stage = "error";
        this._emitStatus(true);
        this._notice("event", "error", "CLIENT_SOCKET_ERROR", "WebSocket error.", { error: String(err) });
      });

      return;
    }

    // Browser branch
    this.ws.addEventListener("open", () => {
      this._notice("state", "info", "CLIENT_CONNECTED", "WebSocket connected.", {});
      sendResume();
    });
    this.ws.addEventListener("message", (evt: any) => {
      void this._handleMessage(evt.data);
    });
    this.ws.addEventListener("close", (evt: any) => {
      this._handleClose(Number(evt.code || 0), String(evt.reason || ""));
    });
    this.ws.addEventListener("error", (evt: any) => {
      this.stage = "error";
      this._emitStatus(true);
      this._notice("event", "error", "CLIENT_SOCKET_ERROR", "WebSocket error.", { error: String(evt) });
    });
  }

  /** Close the socket. Auto-reconnect is disabled for this close. */
  close(): void {
    this._closing = true;
    this._explicitClose = true;
    this._clearReconnectTimer();
    const ws = this.ws;
    if (!ws) return;
    try {
      if (ws.readyState === 0 || ws.readyState === 1) ws.close();
    } catch {
      // ignore
    }
  }

  /** Returns a snapshot of the discovered series registry. */
  getRegistrySnapshot(): SeriesRegistryRow[] {
    return Array.from(this._reg.values()).map((r: any) => ({
      id: r.id,
      count: r.count,
      firstSeq: r.firstSeq,
      lastSeq: r.lastSeq,
      firstMs: r.firstMs,
      lastMs: r.lastMs,
      gaps: r.gaps || 0,
      missed: r.missed || 0,
    }));
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private _loadCursor(): number {
    if (!this.storage) return 0;
    try {
      const raw = this.storage.getItem(this.storageKey);
      if (!raw) return 0;
      const n = Math.floor(Number(raw));
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  private _persistCursor(v: number, removeIfZero: boolean = false): void {
    if (!this.storage) return;
    try {
      if (removeIfZero && v <= 0 && typeof this.storage.removeItem === "function") {
        this.storage.removeItem(this.storageKey);
      } else {
        this.storage.setItem(this.storageKey, String(v));
      }
    } catch {
      // ignore storage errors
    }
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._autoReconnectNextDelayMs = null;
  }

  private _scheduleReconnect(reason: any): void {
    if (!this._autoReconnect || this._explicitClose) return;
    if (this._suppressAutoReconnectOnce) {
      this._suppressAutoReconnectOnce = false;
      return;
    }

    this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
    const base = this._autoReconnectInitialDelayMs || 1000;
    let delay = base * Math.pow(2, this._reconnectAttempts - 1);
    const max = this._autoReconnectMaxDelayMs;
    if (typeof max === "number" && max > 0 && delay > max) delay = max;
    this._autoReconnectNextDelayMs = delay;

    this._clearReconnectTimer();
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this.connect();
    }, delay);

    this._notice("event", "warn", "CLIENT_RECONNECT_SCHEDULED", `Reconnect scheduled in ${delay}ms.`, {
      attempts: this._reconnectAttempts,
      delayMs: delay,
      reason,
    });
    this._emitStatus(true);
  }

  private _forceReconnectFromStart(reasonCode: string, details: Record<string, any>): void {
    // Reset cursor and reconnect quickly. Suppress the normal auto-reconnect scheduling for this close.
    this.resetCursor({ persist: true });
    this._suppressAutoReconnectOnce = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
    setTimeout(() => {
      this._notice("event", "info", reasonCode, "Reconnecting from start…", details);
      this.connect();
    }, 50);
  }

  private _handleClose(code: number, reason: string): void {
    this.stage = "closed";
    this._emitStatus(true);

    const c = Number(code || 0);
    if (c === 1000 || c === 1001) {
      this._notice("state", "info", "CLIENT_CLOSED_NORMAL", "Connection closed normally.", { code: c, reason });
    } else if (c === 1006) {
      this._notice("state", "warn", "CLIENT_CLOSED_ABRUPT", "Client disconnected abruptly (no close handshake).", {
        code: c,
        reason,
      });
    } else {
      const lvl: NoticeLevel = c ? "warn" : "warn";
      this._notice("state", lvl, "CLIENT_CLOSED", `Connection closed (code=${c || "n/a"}).`, { code: c, reason });
    }

    this._scheduleReconnect({ code: c, reason });
  }

  private async _handleMessage(raw: any): Promise<void> {
    if (this._closing) return;

    try {
      // TEXT FRAME
      if (typeof raw === "string") {
        if (this.wireFormat === null) this.wireFormat = "text";

        let msg: any;
        try {
          msg = JSON.parse(raw);
        } catch (err) {
          this._decodeErrorsText++;
          this._notice("event", "warn", "CLIENT_DECODE_ERROR", "Failed to parse JSON control frame.", {
            wireFormat: "text",
            phase: "json-parse",
            error: String(err),
          });
          this._emitStatus();
          return;
        }

        const t = String(msg?.type || "");

        if (t === "history" || t === "delta" || t === "live") {
          const samples = Array.isArray(msg.samples) ? msg.samples : [];
          this._handleSamplesFrame(t, samples);
          return;
        }

        if (t === "init_begin") {
          this._minSeq = _safeNumber(msg.min_seq, 0);
          this._wmSeq = _safeNumber(msg.wm_seq, 0);
          this._ringCapacity = Number.isFinite(Number(msg.ring_capacity)) ? Number(msg.ring_capacity) : null;

          // AUTO POLICY: detect when our stored cursor is ahead of the server.
          if (this._cursorPolicy === "auto" && this._cursorSeq > 0 && this._wmSeq < this._cursorSeq) {
            this._notice(
              "event",
              "warn",
              "SERVER_CURSOR_AHEAD",
              `Saved cursor (${this._cursorSeq}) is ahead of server wm_seq (${this._wmSeq}). ` +
                `The server likely restarted or you connected to a different feed. Resetting cursor and reconnecting from start.`,
              { cursorSeq: this._cursorSeq, wmSeq: this._wmSeq, minSeq: this._minSeq },
            );
            this._forceReconnectFromStart("CLIENT_AUTO_RESET", { cursorSeq: this._cursorSeq, wmSeq: this._wmSeq });
            return;
          }

          const start = Math.max(this._requestedFromSeq, this._minSeq);
          this._expectedHistory = this._wmSeq >= start ? this._wmSeq - start + 1 : 0;
          this._historyReceived = 0;
          this._deltaReceived = 0;
          this._liveReceived = 0;
          this.stage = "history";

          this._notice(
            "state",
            "info",
            "SERVER_INIT_BEGIN",
            `Handshake: server has seq [${this._minSeq}..${this._wmSeq}] (ring_capacity=${this._ringCapacity ?? "n/a"}).`,
            {
              minSeq: this._minSeq,
              wmSeq: this._wmSeq,
              ringCapacity: this._ringCapacity,
              requestedFromSeq: this._requestedFromSeq,
            },
          );

          this._emitStatus(true);
          this._onControl?.(msg);
          this._onEvent?.({ type: 'init_begin', min_seq: this._minSeq, wm_seq: this._wmSeq, ring_capacity: this._ringCapacity });
          return;
        }

        if (t === "init_complete") {
          this._serverResumeFromSeq = _safeNumber(msg.resume_from, this._wmSeq);
          this._resumeTruncated = !!msg.resume_truncated;
          this.stage = "live";
          this._emitStatus(true);

          if (this._resumeTruncated) {
            this._notice(
              "event",
              "warn",
              "SERVER_HISTORY_TRUNCATED",
              "History truncated: you connected after the ring buffer advanced. You will only receive the tail that is still in memory.",
              { minSeq: this._minSeq, requestedFromSeq: this._requestedFromSeq, ringCapacity: this._ringCapacity },
            );
          } else {
            this._notice("state", "info", "SERVER_INIT_COMPLETE", "Initialization complete. Live streaming started.", {
              resumeFrom: this._serverResumeFromSeq,
            });
          }

          this._onControl?.(msg);
          this._onEvent?.({ type: 'init_complete', resume_from: this._serverResumeFromSeq, resume_truncated: this._resumeTruncated });
          return;
        }

        if (t === "heartbeat") {
          const ts = _safeNumber(msg.ts_ms, 0);
          if (ts > 0) this.lastHeartbeatLagMs = _nowMs() - ts;
          this._emitStatus();
          this._onControl?.(msg);
          this._onEvent?.({ type: 'heartbeat', ts_ms: _safeNumber(msg.ts_ms, 0) });
          return;
        }

        if (t === "test_done") {
          this._notice("state", "info", "SERVER_TEST_DONE", "Server reports playback/test completed.", msg);
          this._onControl?.(msg);
          this._onEvent?.({ type: 'test_done' });
          this._emitStatus(true);
          return;
        }

        if (t === "error") {
          this._notice("event", "error", "SERVER_ERROR", `Server error: ${String(msg.reason || "unknown")}`, msg);
          this._onControl?.(msg);
          this._onEvent?.({ type: 'error', reason: msg.reason });
          this._emitStatus(true);
          return;
        }

        if (t === "echo") {
          this._notice("event", "debug", "SERVER_ECHO", "Server echoed a client command.", msg);
          this._onControl?.(msg);
          this._onEvent?.({ type: 'echo', ...msg });
          return;
        }

        // Unknown control frame
        this._onControl?.(msg);
        this._onEvent?.({ type: t || 'unknown', ...msg });
        return;
      }

      // BINARY FRAME → samples
      this.wireFormat = "binary";

      let u8: Uint8Array | null = null;
      if (typeof ArrayBuffer !== "undefined" && raw instanceof ArrayBuffer) {
        u8 = new Uint8Array(raw);
      } else if (typeof Blob !== "undefined" && raw instanceof Blob) {
        const buf = await raw.arrayBuffer();
        u8 = new Uint8Array(buf);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } else if (typeof Buffer !== "undefined" && (Buffer as any).isBuffer && (Buffer as any).isBuffer(raw)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const B: any = Buffer;
        u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      } else if (ArrayBuffer.isView && ArrayBuffer.isView(raw)) {
        u8 = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      }

      if (!u8) {
        this._decodeErrorsBinary++;
        this._notice("event", "warn", "CLIENT_DECODE_ERROR", "Unrecognised binary container.", {
          wireFormat: "binary",
          phase: "container",
        });
        this._emitStatus();
        return;
      }

      const frame = this._decodeBinaryFrame(u8);
      if (!frame) {
        this._decodeErrorsBinary++;
        this._notice("event", "warn", "CLIENT_DECODE_ERROR", "Failed to decode binary frame.", {
          wireFormat: "binary",
          phase: "frame",
        });
        this._emitStatus();
        return;
      }

      this._handleSamplesFrame(frame.type, frame.samples);
    } catch (err) {
      const wire = this.wireFormat || (typeof raw === "string" ? "text" : "binary");
      if (wire === "text") this._decodeErrorsText++;
      else this._decodeErrorsBinary++;
      this._notice("event", "warn", "CLIENT_DECODE_ERROR", "Decode handler exception.", {
        wireFormat: wire,
        phase: "handler-exception",
        error: String(err),
      });
      this._emitStatus();
    }
  }

  private _decodeBinaryFrame(u8: Uint8Array): { type: "history" | "delta" | "live"; samples: FeedSample[] } | null {
    if (!u8 || u8.length < 5) return null;
    const view = new DataView(u8.buffer, u8.byteOffset || 0, u8.byteLength || u8.length);
    let off = 0;

    const frameCode = view.getUint8(off);
    off += 1;
    let type: "history" | "delta" | "live" | null = null;
    if (frameCode === 1) type = "history";
    else if (frameCode === 2) type = "delta";
    else if (frameCode === 3) type = "live";
    else return null;

    const count = view.getUint32(off);
    off += 4;
    const samples: FeedSample[] = [];
    const td = this._textDecoder || (this._textDecoder = new TextDecoder("utf-8"));

    outer: for (let i = 0; i < count; i++) {
      if (off + 8 * 3 + 1 > view.byteLength) break;
      const seq = view.getFloat64(off);
      off += 8;
      const seriesSeq = view.getFloat64(off);
      off += 8;
      const t_ms = view.getFloat64(off);
      off += 8;

      const sidLen = view.getUint8(off);
      off += 1;
      if (off + sidLen > view.byteLength) break;
      let sid = "";
      if (sidLen > 0) {
        sid = td.decode(u8.subarray(off, off + sidLen));
      }
      off += sidLen;

      if (off + 1 > view.byteLength) break;
      const payloadType = view.getUint8(off);
      off += 1;

      let payload: any = {};
      switch (payloadType) {
        case 1: // tick
          if (off + 16 > view.byteLength) break outer;
          payload = { price: view.getFloat64(off), volume: view.getFloat64(off + 8) };
          off += 16;
          break;
        case 2: // scalar
          if (off + 8 > view.byteLength) break outer;
          payload = { value: view.getFloat64(off) };
          off += 8;
          break;
        case 3: // ohlc
          if (off + 32 > view.byteLength) break outer;
          payload = {
            o: view.getFloat64(off),
            h: view.getFloat64(off + 8),
            l: view.getFloat64(off + 16),
            c: view.getFloat64(off + 24),
          };
          off += 32;
          break;
        case 4: {
          // signal
          if (off + 1 > view.byteLength) break outer;
          const stratLen = view.getUint8(off);
          off += 1;
          if (off + stratLen + 1 + 4 + 8 + 1 > view.byteLength) break outer;
          const strategy = stratLen ? td.decode(u8.subarray(off, off + stratLen)) : "";
          off += stratLen;
          const sideChar = String.fromCharCode(view.getUint8(off));
          off += 1;
          const desired_qty = view.getInt32(off);
          off += 4;
          const price = view.getFloat64(off);
          off += 8;
          const reasonLen = view.getUint8(off);
          off += 1;
          if (off + reasonLen > view.byteLength) break outer;
          const reason = reasonLen ? td.decode(u8.subarray(off, off + reasonLen)) : "";
          off += reasonLen;
          payload = {
            strategy,
            side: sideChar === "L" ? "long" : "short",
            desired_qty,
            price,
            reason,
          };
          break;
        }
        case 5: {
          // marker
          if (off + 1 > view.byteLength) break outer;
          const stratLen = view.getUint8(off);
          off += 1;
          if (off + stratLen + 1 + 1 > view.byteLength) break outer;
          const strategy = stratLen ? td.decode(u8.subarray(off, off + stratLen)) : "";
          off += stratLen;
          const sideChar = String.fromCharCode(view.getUint8(off));
          off += 1;
          const tagLen = view.getUint8(off);
          off += 1;
          if (off + tagLen + 8 + 4 > view.byteLength) break outer;
          const tag = tagLen ? td.decode(u8.subarray(off, off + tagLen)) : "";
          off += tagLen;
          const price = view.getFloat64(off);
          off += 8;
          const qty = view.getInt32(off);
          off += 4;
          payload = {
            strategy,
            side: sideChar === "L" ? "long" : "short",
            tag,
            price,
            qty,
          };
          break;
        }
        case 6: // pnl
          if (off + 8 > view.byteLength) break outer;
          payload = { value: view.getFloat64(off) };
          off += 8;
          break;
        default:
          // unknown payload type
          break;
      }

      samples.push({
        seq,
        series_seq: seriesSeq,
        series_id: sid,
        t_ms,
        payload,
      });
    }

    return { type: type as any, samples };
  }

  private _handleSamplesFrame(kind: "history" | "delta" | "live", samples: any[]): void {
    if (this._closing) return;
    const list = Array.isArray(samples) ? samples : [];
    let accepted = 0;
    const out: FeedSample[] = [];

    for (const s of list) {
      const seq = Number(s?.seq);
      if (!Number.isFinite(seq)) continue;

      // Global gap detection (for this client)
      if (this._acceptAfterSeq > 0 && seq > this._acceptAfterSeq + 1) {
        const missing = seq - this._acceptAfterSeq - 1;
        this._gapGlobalGaps += 1;
        this._gapGlobalMissing += missing;
      }

      // Dedup
      if (seq <= this._acceptAfterSeq) continue;

      // Normalize payload strategy fallback (future-proof)
      const sid = String(s?.series_id || "");
      const payload = s?.payload && typeof s.payload === "object" ? s.payload : {};
      if (sid.includes(":strategy:") && payload && !payload.strategy) {
        const strat = _parseStrategyIdFromSeriesId(sid);
        if (strat) payload.strategy = strat;
      }
      const t_ms = Number(s?.t_ms);
      const series_seq = Number(s?.series_seq);

      const sample: FeedSample = {
        seq,
        series_id: sid,
        t_ms: Number.isFinite(t_ms) ? t_ms : 0,
        series_seq: Number.isFinite(series_seq) ? series_seq : undefined,
        payload,
      };

      out.push(sample);
      this._acceptAfterSeq = seq;
      accepted++;
      this._updateRegistry(sample);
    }

    if (accepted) {
      if (kind === "history") this._historyReceived += accepted;
      else if (kind === "delta") this._deltaReceived += accepted;
      else this._liveReceived += accepted;

      this._sinceLastStatus += accepted;

      try {
        this._onSamples(out);
      } catch {
        /* ignore UI errors */
      }

      // Persist cursor continuously (so browser refresh survives)
      this._cursorSeq = Math.max(this._cursorSeq, this._acceptAfterSeq);
      this._persistCursor(this._cursorSeq);
    }

    if (kind === "delta" && this.stage === "history") this.stage = "delta";
    if (kind === "live" && (this.stage === "history" || this.stage === "delta")) this.stage = "live";

    this._emitStatus();
  }

  private _updateRegistry(sample: FeedSample): void {
    const id = sample?.series_id;
    if (!id) return;
    const t = _safeNumber(sample.t_ms, 0);
    const seq = _safeNumber(sample.seq, 0);
    const sseq = _safeNumber(sample.series_seq, 0);

    let e = this._reg.get(id);
    if (!e) {
      e = {
        id,
        count: 0,
        firstSeq: seq,
        lastSeq: seq,
        firstMs: t,
        lastMs: t,
        prevSeriesSeq: null as number | null,
        gaps: 0,
        missed: 0,
      };
      this._reg.set(id, e);
      this._regDirty = true;
    }

    e.count += 1;
    e.lastSeq = seq;
    e.lastMs = t;

    // Per-series gap detection via series_seq
    if (Number.isFinite(sseq) && sseq > 0) {
      if (e.prevSeriesSeq === null) {
        e.prevSeriesSeq = sseq;
        if (sseq > 1) {
          e.gaps += 1;
          e.missed += sseq - 1;
        }
      } else {
        if (sseq > e.prevSeriesSeq + 1) {
          e.gaps += 1;
          e.missed += sseq - e.prevSeriesSeq - 1;
        }
        e.prevSeriesSeq = sseq;
      }
    }

    this._regDirty = true;
  }

  private _emitStatus(force: boolean = false): void {
    const now = _nowMs();
    const dt = now - this._lastStatusTs;
    if (!force && dt < this._statusThrottleMs) return;

    const rate = dt > 0 ? (this._sinceLastStatus * 1000) / dt : 0;
    this._sinceLastStatus = 0;
    this._lastStatusTs = now;

    const expected = this._expectedHistory || 0;
    const received = Math.min(this._historyReceived, expected);
    const pct = expected ? Math.min(100, Math.round((received / expected) * 100)) : 100;

    // Aggregate per-series gaps
    let totalSeriesGaps = 0;
    let totalSeriesMissed = 0;
    for (const e of this._reg.values()) {
      totalSeriesGaps += e.gaps || 0;
      totalSeriesMissed += e.missed || 0;
    }

    const status: WsFeedStatus = {
      type: "status",
      stage: this.stage,
      url: this.url,
      cursorPolicy: this._cursorPolicy,
      lastSeq: this._acceptAfterSeq || 0,
      bounds: { minSeq: this._minSeq, wmSeq: this._wmSeq, ringCapacity: this._ringCapacity },
      resume: {
        requestedFromSeq: this._requestedFromSeq,
        serverResumeFromSeq: this._serverResumeFromSeq,
        truncated: this._resumeTruncated,
      },
      history: { expected, received: this._historyReceived, pct },
      delta: { received: this._deltaReceived },
      live: { received: this._liveReceived },
      rate: { perSec: Number(rate.toFixed(1)), windowMs: this._statusThrottleMs },
      heartbeatLagMs: this.lastHeartbeatLagMs,
      registry: { total: this._reg.size },
      wireFormat: this.wireFormat,
      gaps: {
        global: { gaps: this._gapGlobalGaps, missed: this._gapGlobalMissing },
        series: { totalSeries: this._reg.size, totalGaps: totalSeriesGaps, totalMissed: totalSeriesMissed },
      },
      decodeErrors: {
        text: this._decodeErrorsText,
        binary: this._decodeErrorsBinary,
      },
      reconnect: {
        enabled: this._autoReconnect,
        attempts: this._reconnectAttempts || 0,
        nextDelayMs: this._autoReconnectNextDelayMs,
      },
      ts: now,
    };

    try {
      this._onStatus?.(status);
    } catch {
      /* ignore UI errors */
    }

    if (this._regDirty) {
      this._regDirty = false;
      try {
        this._onRegistry?.(this.getRegistrySnapshot());
      } catch {
        /* ignore */
      }
    }
  }

  private _notice(
    kind: NoticeKind,
    level: NoticeLevel,
    code: string,
    text: string,
    details: Record<string, any> = {},
  ): void {
    const n: FeedNotice = {
      kind,
      level,
      code,
      text,
      ts: _nowMs(),
      details,
    };
    try {
      this._onNotice?.(n);
    } catch {
      /* ignore */
    }
  }
}

// ============= Type Aliases for backward compatibility =============
// These aliases allow imports like: import { Sample, RegistryRow, FeedStatus } from '@/lib/wsfeed-client'

/** Alias for FeedSample - represents a single data sample from the feed */
export type Sample = FeedSample;

/** Alias for SeriesRegistryRow - represents metadata for a time series */
export type RegistryRow = SeriesRegistryRow;

/** Alias for WsFeedStatus - comprehensive status snapshot */
export type FeedStatus = WsFeedStatus;
