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
  registry: { total: number; gaps: number; missed: number };
  wireFormat: 'text' | 'binary' | null;
  gaps: {
    global: { gaps: number; missed: number };
    series: { totalSeries: number; totalGaps: number; totalMissed: number };
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

  constructor(opts: WsFeedClientOptions) {
    if (!opts.url) throw new Error("WsFeedClient: url required");
    if (typeof opts.onSamples !== 'function') throw new Error("WsFeedClient: onSamples callback required");

    this.url = opts.url;
    this.wsFactory = opts.wsFactory || ((u: string) => new WebSocket(u));
    this.storage = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : new MemoryStorage());
    this.storageKey = opts.storageKey || 'feed:last_seq';
    this.onSamples = opts.onSamples;
    this.onEvent = opts.onEvent || (() => {});
    this.onStatus = opts.onStatus || (() => {});
    this.onRegistry = opts.onRegistry || (() => {});
    this._statusThrottleMs = opts.statusThrottleMs || 250;

    const saved = this.storage.getItem(this.storageKey);
    this.lastSeq = saved ? Number(saved) : 0;
    this.resumeFromRequested = (this.lastSeq || 0) + 1;
  }

  getLastSeq(): number {
    return this.lastSeq;
  }

  setLastSeq(v: number): void {
    this.lastSeq = v;
    this.storage.setItem(this.storageKey, String(v));
  }

  connect(): void {
    this._closing = false;
    this.stage = 'connecting';
    this._emitStatus();

    this.ws = this.wsFactory(this.url);

    // In browser, prefer ArrayBuffer for binary frames
    try {
      if (typeof WebSocket !== 'undefined' && this.ws instanceof WebSocket) {
        (this.ws as WebSocket).binaryType = 'arraybuffer';
      }
    } catch {
      // Ignore if not supported
    }

    const sendResume = () => {
      this.resumeFromRequested = (this.lastSeq || 0) + 1;
      this.ws?.send(JSON.stringify({ type: 'resume', from_seq: this.resumeFromRequested }));
    };

    // Support both browser and Node.js WebSocket APIs
    const wsAny = this.ws as any;
    if (wsAny.on) {
      // Node.js 'ws' library
      wsAny.on('open', sendResume);
      wsAny.on('message', (buf: any) => { void this._handleMessage(buf); });
      wsAny.on('close', () => {
        this.stage = 'closed';
        this._emitStatus(true);
        this.onEvent({ type: 'closed' });
      });
      wsAny.on('error', (e: any) => {
        this.stage = 'error';
        this._emitStatus(true);
        this.onEvent({ type: 'error', error: e });
      });
    } else {
      // Browser WebSocket API
      this.ws.addEventListener('open', sendResume);
      this.ws.addEventListener('message', (evt) => { void this._handleMessage(evt.data); });
      this.ws.addEventListener('close', () => {
        this.stage = 'closed';
        this._emitStatus(true);
        this.onEvent({ type: 'closed' });
      });
      this.ws.addEventListener('error', (e) => {
        this.stage = 'error';
        this._emitStatus(true);
        this.onEvent({ type: 'error', error: e });
      });
    }
  }

  close(): void {
    this._closing = true;
    try {
      this.ws?.close();
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
        } catch {
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
          const start = Math.max(this.resumeFromRequested, this.minSeq);
          this.expectedHistory = (this.wmSeq >= start) ? (this.wmSeq - start + 1) : 0;
          this.historyReceived = 0;
          this.deltaReceived = 0;
          this.liveReceived = 0;
          this.stage = 'history';
          this._emitStatus(true);
          this.onEvent(msg as FeedEvent);
          return;
        }

        if (t === 'init_complete') {
          this.resumeFromServer = Number(msg.resume_from || this.wmSeq);
          this.resumeTruncated = !!msg.resume_truncated;
          this.stage = 'live';
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

        if (t === 'test_done' || t === 'error' || t === 'closed') {
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
        const view = raw as ArrayBufferView;
        u8 = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
      } else {
        // Last resort
        return;
      }

      const frame = this._decodeBinaryFrame(u8);
      if (!frame) return;
      this._handleSamplesFrame(frame.type, frame.samples);
    } catch {
      // Any decode error → ignore this frame
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
    const t = kind;
    const list = Array.isArray(samples) ? samples : [];
    let accepted = 0;
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

      // Dedup by global seq
      if (seq <= this.lastSeq) continue;

      out.push(s);
      this.lastSeq = seq;
      accepted++;
      this._updateRegistry(s);
    }

    if (accepted) {
      if (t === 'history') this.historyReceived += accepted;
      else if (t === 'delta') this.deltaReceived += accepted;
      else this.liveReceived += accepted;

      this._sinceLastStatus += accepted;

      this.onSamples(out);
      this.setLastSeq(this.lastSeq);
    }

    if (t === 'delta' && this.stage === 'history') this.stage = 'delta';
    if (t === 'live' && (this.stage === 'history' || this.stage === 'delta')) this.stage = 'live';

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
      registry: {
        total: this._reg.size,
        gaps: totalSeriesGaps,
        missed: totalSeriesMissed
      },
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
