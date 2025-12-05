// Series Store - Preallocated circular buffers for all data series
// This is the central data store that persists across layout changes

import type { Sample } from './wsfeed-client';

export interface CircularBuffer {
  xValues: Float64Array;
  yValues: Float64Array;
  // For OHLC data
  openValues?: Float64Array;
  highValues?: Float64Array;
  lowValues?: Float64Array;
  closeValues?: Float64Array;
  // Buffer state
  capacity: number;
  head: number;  // Write position
  count: number; // Current number of items
}

export interface SeriesMetadata {
  seriesId: string;
  seriesType: 'tick' | 'ohlc' | 'indicator' | 'pnl' | 'marker' | 'signal' | 'bar' | 'unknown';
  firstSeq: number;
  lastSeq: number;
  firstMs: number;
  lastMs: number;
  pointCount: number;
}

export interface SeriesStoreEntry {
  buffer: CircularBuffer;
  metadata: SeriesMetadata;
  dirty: boolean; // Has new data since last drain
}

export type SeriesStoreListener = (entries: Map<string, SeriesStoreEntry>) => void;

class SeriesStoreClass {
  private entries: Map<string, SeriesStoreEntry> = new Map();
  private defaultCapacity: number = 1_000_000;
  private maxTotalPoints: number = 10_000_000;
  private totalPoints: number = 0;
  private listeners: Set<SeriesStoreListener> = new Set();
  
  // Configure the store with UI config values
  configure(config: { pointsPerSeries?: number; maxPointsTotal?: number }) {
    if (config.pointsPerSeries) {
      this.defaultCapacity = config.pointsPerSeries;
    }
    if (config.maxPointsTotal) {
      this.maxTotalPoints = config.maxPointsTotal;
    }
    console.log(`[SeriesStore] Configured: capacity=${this.defaultCapacity}, maxTotal=${this.maxTotalPoints}`);
  }
  
  // Get or create a buffer for a series
  getOrCreate(seriesId: string): SeriesStoreEntry {
    let entry = this.entries.get(seriesId);
    if (!entry) {
      entry = this.createEntry(seriesId);
      this.entries.set(seriesId, entry);
      console.log(`[SeriesStore] Created buffer for ${seriesId} with capacity ${this.defaultCapacity}`);
    }
    return entry;
  }
  
  private createEntry(seriesId: string): SeriesStoreEntry {
    const isOhlc = seriesId.includes(':ohlc');
    const capacity = this.defaultCapacity;
    
    const buffer: CircularBuffer = {
      xValues: new Float64Array(capacity),
      yValues: new Float64Array(capacity),
      capacity,
      head: 0,
      count: 0,
    };
    
    // Allocate OHLC arrays if needed
    if (isOhlc) {
      buffer.openValues = new Float64Array(capacity);
      buffer.highValues = new Float64Array(capacity);
      buffer.lowValues = new Float64Array(capacity);
      buffer.closeValues = new Float64Array(capacity);
    }
    
    return {
      buffer,
      metadata: {
        seriesId,
        seriesType: this.inferSeriesType(seriesId),
        firstSeq: 0,
        lastSeq: 0,
        firstMs: 0,
        lastMs: 0,
        pointCount: 0,
      },
      dirty: false,
    };
  }
  
  private inferSeriesType(seriesId: string): SeriesMetadata['seriesType'] {
    if (seriesId.includes(':ticks')) return 'tick';
    if (seriesId.includes(':ohlc')) return 'ohlc';
    if (seriesId.includes(':sma') || seriesId.includes(':ema') || seriesId.includes(':rsi')) return 'indicator';
    if (seriesId.includes(':pnl')) return 'pnl';
    if (seriesId.includes(':marker')) return 'marker';
    if (seriesId.includes(':signal')) return 'signal';
    if (seriesId.includes(':bar')) return 'bar';
    return 'unknown';
  }
  
  // Append samples to the store
  appendSamples(samples: Sample[]): void {
    for (const sample of samples) {
      const entry = this.getOrCreate(sample.series_id);
      this.appendToBuffer(entry, sample);
    }
    this.notifyListeners();
  }
  
  private appendToBuffer(entry: SeriesStoreEntry, sample: Sample): void {
    const { buffer, metadata } = entry;
    const payload = sample.payload;
    
    // Circular buffer write
    const idx = buffer.head;
    // SciChart DateTimeNumericAxis expects Unix timestamp in SECONDS, not milliseconds
    const xVal = sample.t_ms / 1000;
    buffer.xValues[idx] = xVal;
    
    // Handle different payload types
    if (buffer.openValues && 'o' in payload) {
      // OHLC data
      const oVal = Number(payload.o) || 0;
      const hVal = Number(payload.h) || 0;
      const lVal = Number(payload.l) || 0;
      const cVal = Number(payload.c) || 0;
      buffer.openValues[idx] = oVal;
      buffer.highValues![idx] = hVal;
      buffer.lowValues![idx] = lVal;
      buffer.closeValues![idx] = cVal;
      buffer.yValues[idx] = cVal; // Use close as Y
      
      // Debug: Log first few OHLC samples
      if (metadata.pointCount < 3) {
        console.log(`[SeriesStore] OHLC sample: series=${metadata.seriesId}, x=${xVal}, o=${oVal}, h=${hVal}, l=${lVal}, c=${cVal}`);
      }
    } else {
      // Tick/indicator data - extract y value
      const yVal = Number(payload.y ?? payload.price ?? payload.value ?? 0);
      buffer.yValues[idx] = yVal;
      
      // Debug: Log first few samples for all XY series
      if (metadata.pointCount < 3) {
        console.log(`[SeriesStore] XY sample: series=${metadata.seriesId}, x=${xVal}, y=${yVal}, payload=`, payload);
      }
    }
    
    // Update head and count
    buffer.head = (buffer.head + 1) % buffer.capacity;
    if (buffer.count < buffer.capacity) {
      buffer.count++;
      this.totalPoints++;
    }
    
    // Update metadata
    if (metadata.pointCount === 0) {
      metadata.firstSeq = sample.seq;
      metadata.firstMs = sample.t_ms;
    }
    metadata.lastSeq = sample.seq;
    metadata.lastMs = sample.t_ms;
    metadata.pointCount = buffer.count;
    
    entry.dirty = true;
    
    // Check global limit and trim if needed
    this.enforceGlobalLimit();
  }
  
  private enforceGlobalLimit(): void {
    if (this.totalPoints <= this.maxTotalPoints) return;
    
    // Find oldest series and trim
    // Simple strategy: trim 10% from all series proportionally
    const trimRatio = 0.1;
    for (const entry of this.entries.values()) {
      const trimCount = Math.floor(entry.buffer.count * trimRatio);
      if (trimCount > 0) {
        entry.buffer.count -= trimCount;
        this.totalPoints -= trimCount;
      }
    }
  }
  
  // Get linearized data from circular buffer (for chart consumption)
  getLinearizedData(seriesId: string): {
    x: Float64Array;
    y: Float64Array;
    o?: Float64Array;
    h?: Float64Array;
    l?: Float64Array;
    c?: Float64Array;
  } | null {
    const entry = this.entries.get(seriesId);
    if (!entry || entry.buffer.count === 0) return null;
    
    const { buffer } = entry;
    const count = buffer.count;
    
    // Linearize circular buffer
    const startIdx = buffer.count === buffer.capacity 
      ? buffer.head 
      : 0;
    
    const x = new Float64Array(count);
    const y = new Float64Array(count);
    
    for (let i = 0; i < count; i++) {
      const srcIdx = (startIdx + i) % buffer.capacity;
      x[i] = buffer.xValues[srcIdx];
      y[i] = buffer.yValues[srcIdx];
    }
    
    const result: ReturnType<typeof this.getLinearizedData> = { x, y };
    
    if (buffer.openValues) {
      const o = new Float64Array(count);
      const h = new Float64Array(count);
      const l = new Float64Array(count);
      const c = new Float64Array(count);
      
      for (let i = 0; i < count; i++) {
        const srcIdx = (startIdx + i) % buffer.capacity;
        o[i] = buffer.openValues[srcIdx];
        h[i] = buffer.highValues![srcIdx];
        l[i] = buffer.lowValues![srcIdx];
        c[i] = buffer.closeValues![srcIdx];
      }
      
      result.o = o;
      result.h = h;
      result.l = l;
      result.c = c;
    }
    
    return result;
  }
  
  // Get all series IDs
  getAllSeriesIds(): string[] {
    return Array.from(this.entries.keys());
  }
  
  // Get all entries
  getAllEntries(): Map<string, SeriesStoreEntry> {
    return this.entries;
  }
  
  // Get metadata for a series
  getMetadata(seriesId: string): SeriesMetadata | null {
    return this.entries.get(seriesId)?.metadata || null;
  }
  
  // Mark series as clean (after draining to chart)
  markClean(seriesId: string): void {
    const entry = this.entries.get(seriesId);
    if (entry) entry.dirty = false;
  }
  
  // Get dirty series
  getDirtySeries(): string[] {
    return Array.from(this.entries.entries())
      .filter(([_, entry]) => entry.dirty)
      .map(([id]) => id);
  }
  
  // Subscribe to changes
  subscribe(listener: SeriesStoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.entries);
      } catch (e) {
        console.error('[SeriesStore] Listener error:', e);
      }
    }
  }
  
  // Get stats
  getStats(): { seriesCount: number; totalPoints: number; maxPoints: number } {
    return {
      seriesCount: this.entries.size,
      totalPoints: this.totalPoints,
      maxPoints: this.maxTotalPoints,
    };
  }
  
  // Clear all data (for testing/reset)
  clear(): void {
    this.entries.clear();
    this.totalPoints = 0;
    this.notifyListeners();
  }
}

// Singleton instance
export const SeriesStore = new SeriesStoreClass();
