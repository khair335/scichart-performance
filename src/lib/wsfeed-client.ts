// wsfeed-client.ts
// Universal WebSocket feed client for SciChart real-time data

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
  firstSeriesSeq: number | null;
  lastSeriesSeq: number | null;
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

    const sendResume = () => {
      this.resumeFromRequested = (this.lastSeq || 0) + 1;
      this.ws?.send(JSON.stringify({ type: 'resume', from_seq: this.resumeFromRequested }));
    };

    this.ws.addEventListener('open', sendResume);
    this.ws.addEventListener('message', (evt) => this._handleMessage(evt.data));
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

  close(): void {
    this._closing = true;
    try {
      this.ws?.close();
    } catch {
      // ignore
    }
  }

  private _handleMessage(raw: string | ArrayBuffer): void {
    if (this._closing) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    const t = msg.type as string;

    if (t === 'init_begin') {
      this.minSeq = Number(msg.min_seq || 0);
      this.wmSeq = Number(msg.wm_seq || 0);
      const start = Math.max(this.resumeFromRequested, this.minSeq);
      this.expectedHistory = this.wmSeq >= start ? this.wmSeq - start + 1 : 0;
      this.historyReceived = 0;
      this.deltaReceived = 0;
      this.liveReceived = 0;
      this.stage = 'history';
      this._emitStatus(true);
      this.onEvent(msg as FeedEvent);
      return;
    }

    if (t === 'history' || t === 'delta' || t === 'live') {
      const samples = Array.isArray(msg.samples) ? (msg.samples as Sample[]) : [];
      let accepted = 0;
      const out: Sample[] = [];

      for (const s of samples) {
        const seq = Number(s.seq);
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
  }

  private _updateRegistry(sample: Sample): void {
    const id = sample?.series_id;
    if (!id) return;
    const t = Number(sample.t_ms ?? 0);
    const seq = Number(sample.seq ?? 0);
    const sseqRaw = sample.series_seq;
    const sseq = typeof sseqRaw === 'number' && Number.isFinite(sseqRaw) ? sseqRaw : null;

    let e = this._reg.get(id);
    if (!e) {
      e = {
        id,
        count: 0,
        firstSeq: seq,
        lastSeq: seq,
        firstMs: t,
        lastMs: t,
        firstSeriesSeq: null,
        lastSeriesSeq: null,
        gaps: 0,
        missed: 0
      };
      this._reg.set(id, e);
    }

    e.count += 1;
    e.lastSeq = seq;
    e.lastMs = t;

    if (sseq !== null) {
      if (e.lastSeriesSeq === null) {
        e.firstSeriesSeq = sseq;
        if (sseq > 1) {
          e.gaps += 1;
          e.missed += sseq - 1;
        }
      } else if (sseq > e.lastSeriesSeq + 1) {
        const gap = sseq - e.lastSeriesSeq - 1;
        e.gaps += 1;
        e.missed += gap;
      }
      e.lastSeriesSeq = sseq;
    }

    this._regDirty = true;
  }

  getRegistrySnapshot(): RegistryRow[] {
    return Array.from(this._reg.values()).map((r) => ({ ...r }));
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

    let totalGaps = 0;
    let totalMissed = 0;
    for (const r of this._reg.values()) {
      totalGaps += r.gaps || 0;
      totalMissed += r.missed || 0;
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
        gaps: totalGaps,
        missed: totalMissed
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
