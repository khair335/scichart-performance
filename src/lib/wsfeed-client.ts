// wsfeed-client.ts
//
// Universal WebSocket feed client (browser & Node).
// - JSON control frames (init/heartbeat/test_done/...).
// - Samples can arrive as:
//     * JSON (text frames), or
//     * compact binary frames (when server uses --ws-format=binary).
// - No-drop handoff (watermark → history ≤ wm → delta → init_complete → live).
// - Dedupes by seq; persists last_seq via provided storage (or localStorage).
// - Emits high-level STATUS snapshots for UI: stage, progress, rate, heartbeat lag,
//   wireFormat, gap stats (global + per-series summary).
// - Maintains a discovered-series registry (works for ticks/bars/indicators/strategy/pnl).
//
// Binary sample frame layout (big-endian):
//
//   u8   frame_type        (1=history, 2=delta, 3=live)
//   u32  sample_count
//   repeated sample_count times:
//       f64  seq
//       f64  series_seq
//       f64  t_ms
//       u8   series_id_len (L)
//       Lb   series_id UTF-8
//       u8   payload_type  (1=tick,2=scalar(value),3=ohlc,4=signal,5=marker,6=pnl)
//       ...  payload bytes (see server.py for exact layout)
//
// The client decodes this back into:
//   { seq, series_seq, series_id, t_ms, payload: {...} }

export interface Sample {
  seq: number;
  series_id: string;
  t_ms: number;
  payload: Record<string, unknown>;
  series_seq?: number;
}

export interface RegistryRow {
  id: string;
  count: number;
  firstSeq: number;
  lastSeq: number;
  firstMs: number;
  lastMs: number;
  firstSeriesSeq?: number | null;  // Optional to match wsfeed-client.js (not exposed in snapshot)
  lastSeriesSeq?: number | null;    // Optional to match wsfeed-client.js (not exposed in snapshot)
  gaps: number;
  missed: number;
}

export interface FeedStatus {
  type: 'status';
  stage: string;
  lastSeq: number;
  bounds: { minSeq: number; wmSeq: number };
  resume: { requested: number; server: number | null; truncated: boolean };
  history: { expected: number; received: number; pct: number };
  delta: { received: number };
  live: { received: number };
  rate: { perSec: number; windowMs: number };
  heartbeatLagMs: number | null;
  registry: { total: number };
  wireFormat: 'text' | 'binary' | null;
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

export interface FeedEvent {
  type: string;
  [key: string]: unknown;
}

interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
  removeItem(k: string): void;
}

export class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  getItem(k: string): string | null {
    return this.data.has(k) ? this.data.get(k)! : null;
  }
  setItem(k: string, v: string): void {
    this.data.set(k, String(v));
  }
  removeItem(k: string): void {
    this.data.delete(k);
  }
}

interface WsFeedClientOptions {
  url: string;
  wsFactory?: (url: string) => WebSocket;
  storage?: Storage;
  onSamples: (samples: Sample[]) => void;
  onEvent?: (evt: FeedEvent) => void;
  onStatus?: (status: FeedStatus) => void;
  onRegistry?: (rows: RegistryRow[]) => void;
  storageKey?: string;
  statusThrottleMs?: number;
  autoReconnect?: boolean;
  autoReconnectInitialDelayMs?: number;
  autoReconnectMaxDelayMs?: number;
}

export class WsFeedClient {
  private url: string;
  private wsFactory: (url: string) => WebSocket;
  private storage: Storage;
  private storageKey: string;
  private onSamples: (samples: Sample[]) => void;
  private onEvent: (evt: FeedEvent) => void;
  private onStatus: (status: FeedStatus) => void;
  private onRegistry: (rows: RegistryRow[]) => void;

  private lastSeq: number;
  private ws: WebSocket | null = null;
  private _closing = false;
  public stage = 'idle';

  private minSeq = 0;
  private wmSeq = 0;
  private resumeFromRequested = 0;
  private resumeFromServer: number | null = null;
  private resumeTruncated = false;

  private expectedHistory = 0;
  private historyReceived = 0;
  private deltaReceived = 0;
  private liveReceived = 0;
  private lastDeltaFrameTime = 0; // Track when we last received a delta frame
  private deltaCompleteCheckTimer: ReturnType<typeof setTimeout> | null = null;

  private _statusThrottleMs: number;
  private _sinceLastStatus = 0;
  private _lastStatusTs = 0;
  public lastHeartbeatLagMs: number | null = null;

  private _reg = new Map<string, RegistryRow>();
  private _regDirty = false;

  // Wire format tracking
  public wireFormat: 'text' | 'binary' | null = null;

  // Text decoder for binary frames
  private _textDecoder: TextDecoder | null = null;

  // Global gap detection
  private gapGlobalGaps = 0;     // number of global gap events (seq jump >1)
  private gapGlobalMissing = 0;  // total missing samples across all gaps

  // Decode error counters
  private _decodeErrorsText = 0;
  private _decodeErrorsBinary = 0;

  // Auto-reconnect state
  private _autoReconnect = false;
  private _autoReconnectInitialDelayMs = 1000;
  private _autoReconnectMaxDelayMs = 30000;
  private _reconnectAttempts = 0;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _autoReconnectNextDelayMs: number | null = null;
  private _explicitClose = false;

  constructor(opts: WsFeedClientOptions) {
    if (!opts.url) throw new Error("WsFeedClient: url required");
    if (typeof opts.onSamples !== 'function') throw new Error("WsFeedClient: onSamples callback required");

    this.url = opts.url;
    this.wsFactory = opts.wsFactory || ((u: string) => {
      if (typeof globalThis !== 'undefined' && !globalThis.WebSocket) {
        throw new Error("WsFeedClient: no global WebSocket; pass wsFactory in Node");
      }
      return new WebSocket(u);
    });

    // Simple storage selection:
    // - if user supplied storage → use it
    // - else if browser with localStorage → use it
    // - else fall back to in-memory (Node, tests)
    let defaultStorage: Storage | null = null;
    try {
      // This is fine in Node 18+ and browsers
      defaultStorage = (typeof globalThis !== 'undefined' && globalThis.localStorage) ? globalThis.localStorage as any : null;
    } catch {
      defaultStorage = null;
    }
    this.storage = opts.storage || defaultStorage || new MemoryStorage();

    this.storageKey = opts.storageKey || 'feed:last_seq';
    this.onSamples = opts.onSamples;
    this.onEvent = opts.onEvent || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onRegistry = opts.onRegistry || (() => {});
    this._statusThrottleMs = opts.statusThrottleMs || 250;

    // Auto-reconnect options
    this._autoReconnect = !!opts.autoReconnect;
    this._autoReconnectInitialDelayMs = opts.autoReconnectInitialDelayMs || 1000;
    this._autoReconnectMaxDelayMs = opts.autoReconnectMaxDelayMs || 30000;

    // Dedup cursor
    const saved = this.storage && typeof this.storage.getItem === 'function'
      ? this.storage.getItem(this.storageKey)
      : null;
    const savedLastSeq = saved ? Number(saved) : 0;
    
    // For static data feeds (like ui-feed.exe), we need to always start from seq=1
    // because the server sends all data once and doesn't persist state between connections.
    // We can't know if it's static until we connect, but we can detect it after init_begin.
    // For now, we'll use the saved lastSeq, but we'll reset it if we detect a watermark mismatch.
    this.lastSeq = savedLastSeq;
    this.resumeFromRequested = (this.lastSeq || 0) + 1;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  setLastSeq(v: number): void {
    this.lastSeq = v;
    if (this.storage && typeof this.storage.setItem === 'function') {
      try {
        this.storage.setItem(this.storageKey, String(v));
      } catch {
        // ignore storage errors
      }
    }
  }

  /**
   * Reset resume cursor back to 0 so the next connect() will ask from seq=1.
   */
  resetCursor(options: { persist?: boolean } = {}): void {
    const { persist = true } = options;
    this.lastSeq = 0;
    this.resumeFromRequested = 1;
    this.resumeFromServer = null;
    this.resumeTruncated = false;
    if (persist && this.storage) {
      if (typeof this.storage.removeItem === 'function') {
        try {
          this.storage.removeItem(this.storageKey);
        } catch {
          // ignore
        }
      } else if (typeof this.storage.setItem === 'function') {
        try {
          this.storage.setItem(this.storageKey, '0');
        } catch {
          // ignore
        }
      }
    }
    this._emitStatus(true);
  }

  /** Enable or disable auto-reconnect behaviour. */
  setAutoReconnect(enabled: boolean): void {
    this._autoReconnect = !!enabled;
    if (!this._autoReconnect) {
      this._clearReconnectTimer();
      this._reconnectAttempts = 0;
      this._autoReconnectNextDelayMs = null;
    }
    this._emitStatus(true);
  }

  private _clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._autoReconnectNextDelayMs = null;
  }

  private _clearDeltaCompleteTimer(): void {
    if (this.deltaCompleteCheckTimer) {
      clearTimeout(this.deltaCompleteCheckTimer);
      this.deltaCompleteCheckTimer = null;
    }
    this.lastDeltaFrameTime = 0;
  }

  /**
   * Clear localStorage on session complete to ensure fresh start on page refresh.
   * This prevents showing "SESSION COMPLETE" with no data on first refresh,
   * and prevents mixing old data with new data when server restarts.
   */
  private _clearStorageOnSessionComplete(): void {
    console.log(`[WsFeedClient] 🧹 Clearing stored lastSeq on session complete to ensure fresh start`);
    this.lastSeq = 0;
    this.resumeFromRequested = 1;
    if (this.storage) {
      if (typeof this.storage.removeItem === 'function') {
        try {
          this.storage.removeItem(this.storageKey);
        } catch {
          // ignore
        }
      } else if (typeof this.storage.setItem === 'function') {
        try {
          this.storage.setItem(this.storageKey, '0');
        } catch {
          // ignore
        }
      }
    }
  }

  private _scheduleReconnect(reason: { code?: number; reason?: string }): void {
    if (!this._autoReconnect || this._explicitClose) return;

    // CRITICAL: Don't schedule reconnect if we're already connecting
    // This prevents multiple simultaneous connection attempts that can cause handshake failures
    if (this.stage === 'connecting' && this.ws && ((this.ws as any).readyState === 0 || (this.ws as any).readyState === 1)) {
      console.log(`[WsFeedClient] ⏸️ Already connecting, skipping reconnect scheduling`);
      return;
    }

    this._reconnectAttempts = (this._reconnectAttempts || 0) + 1;
    // CRITICAL: Use faster, more aggressive reconnection for better UX
    // Start with 500ms instead of 1000ms, and cap at 5 seconds instead of 30 seconds
    const base = this._autoReconnectInitialDelayMs || 500; // Faster initial retry
    let delay = base * Math.pow(2, Math.min(this._reconnectAttempts - 1, 3)); // Cap exponential backoff at 3 attempts
    const max = this._autoReconnectMaxDelayMs || 5000; // Cap at 5 seconds instead of 30
    if (typeof max === 'number' && max > 0 && delay > max) {
      delay = max;
    }
    this._autoReconnectNextDelayMs = delay;
    this._clearReconnectTimer();

    console.log(`[WsFeedClient] 🔄 Scheduling reconnect attempt ${this._reconnectAttempts} in ${delay}ms`);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      // CRITICAL: Double-check we're not already connecting before attempting reconnect
      // This prevents multiple simultaneous connection attempts that can cause handshake failures
      if (this.stage !== 'connecting' || !this.ws || ((this.ws as any).readyState !== 0 && (this.ws as any).readyState !== 1)) {
        this.connect();
      } else {
        console.log(`[WsFeedClient] ⏸️ Skipping reconnect - already connecting`);
      }
    }, delay);

    try {
      this.onEvent({
        type: 'reconnect_scheduled',
        attempts: this._reconnectAttempts,
        delayMs: delay,
        reason,
      });
    } catch {
      // ignore
    }
    this._emitStatus(true);
  }

  connect(): void {
    // CRITICAL: Prevent multiple simultaneous connection attempts
    // If we're already connecting, don't start another connection
    if (this.stage === 'connecting' && this.ws && ((this.ws as any).readyState === 0 || (this.ws as any).readyState === 1)) {
      console.log(`[WsFeedClient] ⏸️ Already connecting (stage=${this.stage}, readyState=${(this.ws as any).readyState}), skipping duplicate connect()`);
      return;
    }

    this._closing = false;
    this._explicitClose = false;
    this._clearReconnectTimer();
    this.stage = 'connecting';
    this._emitStatus();

    // If there is an existing socket, close it defensively
    // CRITICAL: Only close if socket is OPEN (readyState === 1), not if CONNECTING (readyState === 0)
    // Closing a CONNECTING socket can cause handshake failures on the server
    if (this.ws) {
      const readyState = (this.ws as any).readyState;
      if (readyState === 1) { // OPEN - safe to close
        try {
          console.log(`[WsFeedClient] 🔌 Closing existing OPEN socket before reconnecting`);
          this.ws.close();
        } catch {
          // ignore
        }
      } else if (readyState === 0) { // CONNECTING - wait a bit for it to complete or fail
        console.log(`[WsFeedClient] ⏳ Existing socket is CONNECTING, waiting for it to complete or fail`);
        // Don't close a connecting socket - let it complete or fail naturally
        // The close handler will schedule reconnect if needed
        return;
      }
      // Clear the reference after closing
      this.ws = null;
    }

    this.ws = this.wsFactory(this.url);

    // In browser, prefer ArrayBuffer for binary frames
    try {
      if (typeof WebSocket !== 'undefined' && this.ws instanceof WebSocket) {
        (this.ws as WebSocket).binaryType = 'arraybuffer';
      }
    } catch {
      // ignore
    }

    const sendResume = () => {
      // Calculate resume point based on current lastSeq
      this.resumeFromRequested = (this.lastSeq || 0) + 1;
      console.log(`[WsFeedClient] 📤 Sending resume request: from_seq=${this.resumeFromRequested} (lastSeq=${this.lastSeq})`);
      this.ws?.send(JSON.stringify({ type: 'resume', from_seq: this.resumeFromRequested }));
    };

    // --- Node 'ws' branch ---------------------------------------------
    const wsAny = this.ws as any;
    if (wsAny && typeof wsAny.on === 'function') {
      wsAny.on('open', sendResume);

      // NOTE: node 'ws' calls handler as (data, isBinary)
      wsAny.on('message', (data: any, isBinary?: boolean) => {
        let raw = data;

        if (!isBinary) {
          // Text frame → make sure we hand a string to _handleMessage
          if (typeof data !== 'string') {
            if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(data)) {
              raw = data.toString('utf8');
            } else if (ArrayBuffer.isView && ArrayBuffer.isView(data)) {
              raw = new TextDecoder('utf-8').decode(
                new Uint8Array((data as ArrayBufferView).buffer, (data as ArrayBufferView).byteOffset, (data as ArrayBufferView).byteLength)
              );
            }
          }
        }

        void this._handleMessage(raw);
      });

      wsAny.on('close', (code: number, reason: string) => {
        // Don't change stage if already complete - keep it as 'complete'
        if (this.stage !== 'complete') {
          this.stage = 'closed';
        }
        this._emitStatus(true);
        try {
          this.onEvent({ type: 'closed', code, reason });
        } catch {
          // ignore
        }
        // CRITICAL: Don't reconnect if session is complete
        if (this.stage !== 'complete') {
          this._scheduleReconnect({ code, reason });
        } else {
          console.log(`[WsFeedClient] ⏸️ Connection closed but session is complete, not reconnecting`);
        }
      });

      wsAny.on('error', (err: any) => {
        this.stage = 'error';
        this._emitStatus(true);
        this.onEvent({ type: 'error', error: err });
      });

      return; // important: don't fall through to browser branch
    }

    // --- Browser / WebSocket-like branch ------------------------------
    this.ws.addEventListener('open', sendResume);
    this.ws.addEventListener('message', (evt) => {
      void this._handleMessage(evt.data);
    });
    this.ws.addEventListener('close', (evt) => {
      // Don't change stage if already complete - keep it as 'complete'
      if (this.stage !== 'complete') {
        this.stage = 'closed';
      }
      this._emitStatus(true);
      try {
        this.onEvent({ type: 'closed', code: evt.code, reason: evt.reason });
      } catch {
        // ignore
      }
      // CRITICAL: Don't reconnect if session is complete
      if (this.stage !== 'complete') {
        this._scheduleReconnect({ code: evt.code, reason: evt.reason });
      } else {
        console.log(`[WsFeedClient] ⏸️ Connection closed but session is complete, not reconnecting`);
      }
    });
    this.ws.addEventListener('error', (evt) => {
      this.stage = 'error';
      this._emitStatus(true);
      this.onEvent({ type: 'error', error: evt });
    });
  }

  close(): void {
    this._closing = true;
    this._explicitClose = true;
    this._clearReconnectTimer();
    const ws = this.ws;
    if (!ws) return;
    try {
      if ((ws as any).readyState === 0 || (ws as any).readyState === 1) {
        ws.close();
      }
    } catch {
      // ignore
    }
  }

  private async _handleMessage(raw: string | ArrayBuffer | Blob | Buffer): Promise<void> {
    if (this._closing) return;

    try {
      // TEXT FRAME → JSON control or JSON samples
      if (typeof raw === 'string') {
        if (this.wireFormat === null) this.wireFormat = 'text';

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(raw);
        } catch (err) {
          this._decodeErrorsText++;
          try {
            this.onEvent({
              type: 'decode_error',
              wireFormat: 'text',
              phase: 'json-parse',
              error: String(err),
            });
          } catch {
            // ignore
          }
          this._emitStatus();
          return;
        }
        const t = msg.type as string;

        if (t === 'history' || t === 'delta' || t === 'live') {
          const samples = Array.isArray(msg.samples) ? (msg.samples as Sample[]) : [];
          this._handleSamplesFrame(t, samples);
          return;
        }

        if (t === 'init_begin') {
          this.minSeq = Number(msg.min_seq || 0);
          this.wmSeq = Number(msg.wm_seq || 0);
          
          // SIMPLIFIED: Match old version's behavior - just reset cursor, don't reconnect
          // This is faster because it doesn't close/reconnect, just continues with reset cursor
          // Detect server restart: if server's minSeq is lower than our stored lastSeq,
          // OR if server's wmSeq is lower than our stored lastSeq,
          // it means the server has restarted and sequence numbers have reset.
          // Reset lastSeq to 0 to allow accepting new samples.
          if (this.minSeq < this.lastSeq || this.wmSeq < this.lastSeq) {
            console.log(`[WsFeedClient] 🔄 Server restart detected: minSeq=${this.minSeq}, wmSeq=${this.wmSeq}, lastSeq=${this.lastSeq}, resetting lastSeq to 0`);
            this.lastSeq = 0;
            if (this.storage && typeof this.storage.removeItem === 'function') {
              try {
                this.storage.removeItem(this.storageKey);
              } catch {
                // ignore
              }
            }
            // Update resumeFromRequested to match the reset
            this.resumeFromRequested = 1;
          }
          
          const start = Math.max(this.resumeFromRequested, this.minSeq);
          this.expectedHistory = (this.wmSeq >= start) ? (this.wmSeq - start + 1) : 0;
          this.historyReceived = 0;
          this.deltaReceived = 0;
          this.liveReceived = 0;
          this._clearDeltaCompleteTimer(); // Reset delta tracking on new connection
          
          // SIMPLIFIED: Always start in 'history' stage like old version
          // The transitions will happen naturally when delta/live frames arrive
          // This matches the old version's behavior which was faster
          this.stage = 'history';
          
          this._emitStatus(true);
          this.onEvent(msg as FeedEvent);
          return;
        }

        if (t === 'init_complete') {
          this.resumeFromServer = Number(msg.resume_from || this.wmSeq);
          this.resumeTruncated = !!msg.resume_truncated;
          this.stage = 'live';
          // Clear delta complete check timer since we're now in live
          this._clearDeltaCompleteTimer();
          this._emitStatus(true);
          this.onEvent(msg as FeedEvent);
          return;
        }

        if (t === 'heartbeat') {
          if (typeof msg.ts_ms === 'number') {
            this.lastHeartbeatLagMs = Date.now() - (msg.ts_ms as number);
          }
          this._emitStatus();
          this.onEvent(msg as FeedEvent);
          return;
        }

        if (t === 'test_done') {
          // CRITICAL: When session completes, disable auto-reconnect and close gracefully
          // This prevents reloading history after the session is done
          console.log(`[WsFeedClient] ✅ Session complete (test_done), disabling auto-reconnect and closing connection`);
          this.stage = 'complete';
          this.setAutoReconnect(false); // Disable auto-reconnect to prevent reloading
          this._explicitClose = true; // Mark as explicit close to prevent reconnection
          this._clearReconnectTimer(); // Clear any pending reconnect timers
          
          // CRITICAL: Clear localStorage on session complete to ensure fresh start on refresh
          // This prevents showing "SESSION COMPLETE" with no data on first refresh
          this._clearStorageOnSessionComplete();
          
          this._emitStatus(true);
          this.onEvent(msg as FeedEvent);
          
          // Close the connection gracefully after a short delay to ensure the event is processed
          setTimeout(() => {
            if (this.ws && (this.ws as any).readyState === WebSocket.OPEN || (this.ws as any).readyState === 1) {
              try {
                this.ws.close(1000, 'Session complete');
              } catch {
                // ignore
              }
            }
          }, 100);
          return;
        }

        if (t === 'error' || t === 'closed') {
          this._emitStatus(true);
          this.onEvent(msg as FeedEvent);
          return;
        }

        // Unknown JSON type → ignore
        return;
      }

      // BINARY FRAME → compact samples (history/delta/live)
      this.wireFormat = 'binary';

      let u8: Uint8Array;
      if (typeof ArrayBuffer !== 'undefined' && raw instanceof ArrayBuffer) {
        u8 = new Uint8Array(raw);
      } else if (typeof Blob !== 'undefined' && raw instanceof Blob) {
        const buf = await raw.arrayBuffer();
        u8 = new Uint8Array(buf);
      } else if (typeof Buffer !== 'undefined' && Buffer.isBuffer && Buffer.isBuffer(raw)) {
        u8 = new Uint8Array((raw as any).buffer, (raw as any).byteOffset, (raw as any).byteLength);
      } else if (ArrayBuffer.isView && ArrayBuffer.isView(raw)) {
        u8 = new Uint8Array((raw as ArrayBufferView).buffer, (raw as ArrayBufferView).byteOffset, (raw as ArrayBufferView).byteLength);
      } else {
        // Unknown binary container
        this._decodeErrorsBinary++;
        try {
          this.onEvent({
            type: 'decode_error',
            wireFormat: 'binary',
            phase: 'container',
            note: 'unrecognised binary container',
          });
        } catch {
          // ignore
        }
        this._emitStatus();
        return;
      }

      const frame = this._decodeBinaryFrame(u8);
      if (!frame) {
        this._decodeErrorsBinary++;
        try {
          this.onEvent({
            type: 'decode_error',
            wireFormat: 'binary',
            phase: 'frame',
            note: 'decode returned null',
          });
        } catch {
          // ignore
        }
        this._emitStatus();
        return;
      }
      this._handleSamplesFrame(frame.type, frame.samples);
    } catch (err) {
      const wire = this.wireFormat || (typeof raw === 'string' ? 'text' : 'binary');
      if (wire === 'text') this._decodeErrorsText++;
      else this._decodeErrorsBinary++;
      try {
        this.onEvent({
          type: 'decode_error',
          wireFormat: wire,
          phase: 'handler-exception',
          error: String(err),
        });
      } catch {
        // ignore
      }
      this._emitStatus();
      return;
    }
  }

  private _decodeBinaryFrame(u8: Uint8Array): { type: string; samples: Sample[] } | null {
    if (!u8 || !u8.length) return null;
    const view = new DataView(u8.buffer, u8.byteOffset || 0, u8.byteLength || u8.length);
    let off = 0;
    if (view.byteLength < 5) return null;

    const frameCode = view.getUint8(off); off += 1;
    let type: string;
    if (frameCode === 1) type = 'history';
    else if (frameCode === 2) type = 'delta';
    else if (frameCode === 3) type = 'live';
    else return null;

    const count = view.getUint32(off); off += 4;
    const samples: Sample[] = [];
    const td = this._textDecoder || (this._textDecoder = new TextDecoder('utf-8'));

    outer: for (let i = 0; i < count; i++) {
      if (off + 8 * 3 + 1 > view.byteLength) break; // not enough bytes

      const seq = view.getFloat64(off); off += 8;
      const seriesSeq = view.getFloat64(off); off += 8;
      const t_ms = view.getFloat64(off); off += 8;

      const sidLen = view.getUint8(off); off += 1;
      if (off + sidLen > view.byteLength) break;
      let sid = '';
      if (sidLen > 0) {
        const sidBytes = u8.subarray(off, off + sidLen);
        sid = td.decode(sidBytes);
      }
      off += sidLen;

      if (off + 1 > view.byteLength) break;
      const payloadType = view.getUint8(off); off += 1;

      let payload: Record<string, unknown> = {};
      switch (payloadType) {
        case 1: // tick
          if (off + 16 > view.byteLength) break outer;
          {
            const price = view.getFloat64(off); off += 8;
            const volume = view.getFloat64(off); off += 8;
            payload = { price, volume };
          }
          break;
        case 2: // scalar value
          if (off + 8 > view.byteLength) break outer;
          {
            const v = view.getFloat64(off); off += 8;
            payload = { value: v };
          }
          break;
        case 3: // ohlc
          if (off + 32 > view.byteLength) break outer;
          {
            const o = view.getFloat64(off); off += 8;
            const h = view.getFloat64(off); off += 8;
            const l = view.getFloat64(off); off += 8;
            const c = view.getFloat64(off); off += 8;
            payload = { o, h, l, c };
          }
          break;
        case 4: // strategy signal
          if (off + 1 > view.byteLength) break outer;
          {
            const stratLen = view.getUint8(off); off += 1;
            if (off + stratLen + 1 + 4 + 8 + 1 > view.byteLength) break outer;
            let strategy = '';
            if (stratLen > 0) {
              const sb = u8.subarray(off, off + stratLen);
              strategy = td.decode(sb);
            }
            off += stratLen;
            const sideChar = String.fromCharCode(view.getUint8(off)); off += 1;
            const desired_qty = view.getInt32(off); off += 4;
            const price = view.getFloat64(off); off += 8;
            const reasonLen = view.getUint8(off); off += 1;
            if (off + reasonLen > view.byteLength) break outer;
            let reason = '';
            if (reasonLen > 0) {
              const rb = u8.subarray(off, off + reasonLen);
              reason = td.decode(rb);
            }
            off += reasonLen;
            const side = sideChar === 'L' ? 'long' : 'short';
            payload = { strategy, side, desired_qty, price, reason };
          }
          break;
        case 5: // strategy marker
          if (off + 1 > view.byteLength) break outer;
          {
            const stratLen = view.getUint8(off); off += 1;
            if (off + stratLen + 1 + 1 > view.byteLength) break outer;
            let strategy = '';
            if (stratLen > 0) {
              const sb = u8.subarray(off, off + stratLen);
              strategy = td.decode(sb);
            }
            off += stratLen;
            const sideChar = String.fromCharCode(view.getUint8(off)); off += 1;
            const tagLen = view.getUint8(off); off += 1;
            if (off + tagLen + 8 + 4 > view.byteLength) break outer;
            let tag = '';
            if (tagLen > 0) {
              const tb = u8.subarray(off, off + tagLen);
              tag = td.decode(tb);
            }
            off += tagLen;
            const price = view.getFloat64(off); off += 8;
            const qty = view.getInt32(off); off += 4;
            const side = sideChar === 'L' ? 'long' : 'short';
            payload = { strategy, side, tag, price, qty };
          }
          break;
        case 6: // pnl
          if (off + 8 > view.byteLength) break outer;
          {
            const value = view.getFloat64(off); off += 8;
            payload = { value };
          }
          break;
        default:
          // Unknown payload type; nothing more encoded
          break;
      }

      samples.push({
        seq,
        series_seq: seriesSeq,
        series_id: sid,
        t_ms,
        payload
      });
    }

    return { type, samples };
  }

  private _handleSamplesFrame(kind: string, samples: Sample[]): void {
    if (this._closing) return;
    
    // CRITICAL: Don't process samples after session is complete
    // This prevents loading new data after test_done
    if (this.stage === 'complete') {
      console.log(`[WsFeedClient] ⏸️ Ignoring ${samples.length} samples - session already complete`);
      return;
    }
    
    const t = kind;
    const list = Array.isArray(samples) ? samples : [];
    let accepted = 0;
    let rejected = 0;
    const out: Sample[] = [];

    for (const s of list) {
      const seq = Number(s.seq);
      if (!Number.isFinite(seq)) continue;

      // GLOBAL GAP DETECTION (for this client)
      if (this.lastSeq > 0 && seq > this.lastSeq + 1) {
        const missing = seq - this.lastSeq - 1;
        this.gapGlobalGaps += 1;
        this.gapGlobalMissing += missing;
      }

      // Dedup by global seq (silently skip duplicates - normal during reconnect)
      if (seq <= this.lastSeq) {
        rejected++;
        continue;
      }

      out.push(s);
      this.lastSeq = seq;
      accepted++;
      this._updateRegistry(s);
    }
    
    // Debug logging for sample rejection issues
    if (rejected > 0 && accepted === 0 && list.length > 0) {
      const firstSeq = Number(list[0]?.seq);
      const lastSeqInBatch = Number(list[list.length - 1]?.seq);
      console.warn(`[WsFeedClient] ⚠️ All ${rejected} samples rejected in ${t} frame. lastSeq=${this.lastSeq}, batch range=[${firstSeq}..${lastSeqInBatch}]. This usually means server restarted but client has old lastSeq. Consider calling resetCursor().`);
    }

    if (accepted) {
      if (t === 'history') this.historyReceived += accepted;
      else if (t === 'delta') this.deltaReceived += accepted;
      else this.liveReceived += accepted;

      this._sinceLastStatus += accepted;

      try {
        this.onSamples(out);
      } catch {
        // ignore
      }

      this.setLastSeq(this.lastSeq);
    }

    // SIMPLIFIED: Match old version's immediate transitions (no timers, no delays)
    // This ensures fast transitions to live mode when server is ready
    if (t === 'delta' && this.stage === 'history') {
      this.stage = 'delta';
    }
    if (t === 'live' && (this.stage === 'history' || this.stage === 'delta')) {
      this.stage = 'live';
      // Clear any delta complete check timer since we're now in live
      this._clearDeltaCompleteTimer();
    }

    this._emitStatus();
  }

  private _updateRegistry(sample: Sample): void {
    const id = sample?.series_id;
    if (!id) return;
    const t = Number(sample.t_ms ?? 0);
    const seq = Number(sample.seq ?? 0);
    const sseq = Number(sample.series_seq ?? 0);

    let e = this._reg.get(id);
    if (!e) {
      e = {
        id,
        count: 0,
        firstSeq: seq,
        lastSeq: seq,
        firstMs: t,
        lastMs: t,
        prevSeriesSeq: null,
        gaps: 0,
        missed: 0
      } as any; // Use 'any' to allow prevSeriesSeq which is internal-only
      this._reg.set(id, e);
      this._regDirty = true;
    }

    e.count += 1;
    e.lastSeq = seq;
    e.lastMs = t;

    // Per-series gap detection using series_seq (matches wsfeed-client.js)
    if (Number.isFinite(sseq) && sseq > 0) {
      const prevSeriesSeq = (e as any).prevSeriesSeq;
      if (prevSeriesSeq === null) {
        // first time we see this series
        (e as any).prevSeriesSeq = sseq;
        if (sseq > 1) {
          const missing = sseq - 1;
          e.gaps += 1;
          e.missed += missing;
        }
      } else {
        if (sseq > prevSeriesSeq + 1) {
          const gap = sseq - prevSeriesSeq - 1;
          e.gaps += 1;
          e.missed += gap;
        }
        (e as any).prevSeriesSeq = sseq;
      }
    }

    this._regDirty = true;
  }

  getRegistrySnapshot(): RegistryRow[] {
    // Match wsfeed-client.js: don't include firstSeriesSeq/lastSeriesSeq in snapshot
    return Array.from(this._reg.values()).map((r) => ({
      id: r.id,
      count: r.count,
      firstSeq: r.firstSeq,
      lastSeq: r.lastSeq,
      firstMs: r.firstMs,
      lastMs: r.lastMs,
      gaps: r.gaps || 0,
      missed: r.missed || 0
    }));
  }

  private _emitStatus(force = false): void {
    const now = Date.now();
    const dt = now - this._lastStatusTs;
    if (!force && dt < this._statusThrottleMs) return;

    const rate = dt > 0 ? (this._sinceLastStatus * 1000) / dt : 0;
    this._sinceLastStatus = 0;
    this._lastStatusTs = now;

    const expected = this.expectedHistory || 0;
    const received = Math.min(this.historyReceived, expected);
    const pct = expected ? Math.min(100, Math.round((received / expected) * 100)) : 100;

    // Aggregate per-series gap stats
    let totalSeriesGaps = 0;
    let totalSeriesMissed = 0;
    for (const e of this._reg.values()) {
      totalSeriesGaps += e.gaps || 0;
      totalSeriesMissed += e.missed || 0;
    }

    const status: FeedStatus = {
      type: 'status',
      stage: this.stage,
      lastSeq: this.lastSeq,
      bounds: { minSeq: this.minSeq, wmSeq: this.wmSeq },
      resume: {
        requested: this.resumeFromRequested,
        server: this.resumeFromServer,
        truncated: this.resumeTruncated
      },
      history: { expected, received, pct },
      delta: { received: this.deltaReceived },
      live: { received: this.liveReceived },
      rate: { perSec: Number(rate.toFixed(1)), windowMs: this._statusThrottleMs },
      heartbeatLagMs: this.lastHeartbeatLagMs,
      registry: { total: this._reg.size },
      wireFormat: this.wireFormat,
      gaps: {
        global: {
          gaps: this.gapGlobalGaps,
          missed: this.gapGlobalMissing
        },
        series: {
          totalSeries: this._reg.size,
          totalGaps: totalSeriesGaps,
          totalMissed: totalSeriesMissed
        }
      },
      decodeErrors: {
        text: this._decodeErrorsText,
        binary: this._decodeErrorsBinary
      },
      reconnect: {
        enabled: this._autoReconnect,
        attempts: this._reconnectAttempts || 0,
        nextDelayMs: this._autoReconnectNextDelayMs
      },
      ts: now
    };

    try {
      this.onStatus(status);
    } catch {
      // ignore
    }

    if (this._regDirty) {
      this._regDirty = false;
      try {
        this.onRegistry(this.getRegistrySnapshot());
      } catch {
        // ignore
      }
    }
  }
}
