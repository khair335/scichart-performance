// Series Store - Long-lived DataSeries management
// Preserves data across layout changes for optimal performance

import {
  XyDataSeries,
  OhlcDataSeries,
  TSciChart,
} from 'scichart';

export interface SeriesStoreConfig {
  maxTickPoints: number;
  maxSmaPoints: number;
  maxBarPoints: number;
}

const DEFAULT_CONFIG: SeriesStoreConfig = {
  maxTickPoints: 3_000_000,
  maxSmaPoints: 3_000_000,
  maxBarPoints: 1_000_000,
};

interface StoredSeries {
  type: 'xy' | 'ohlc';
  dataSeries: XyDataSeries | OhlcDataSeries;
  lastMs: number;
  count: number;
}

export class SeriesStore {
  private store = new Map<string, StoredSeries>();
  private config: SeriesStoreConfig;
  private wasmContext: TSciChart | null = null;

  constructor(config: Partial<SeriesStoreConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Set the WASM context (must be called after SciChart initialization)
   */
  setWasmContext(wasm: TSciChart): void {
    this.wasmContext = wasm;
  }

  /**
   * Get or create an XY data series (for ticks, SMA, etc.)
   */
  getXySeries(seriesId: string, name?: string): XyDataSeries | null {
    if (!this.wasmContext) return null;

    const existing = this.store.get(seriesId);
    if (existing && existing.type === 'xy') {
      return existing.dataSeries as XyDataSeries;
    }

    // Determine FIFO capacity based on series type
    let fifoCapacity = this.config.maxTickPoints;
    if (seriesId.includes(':sma_') || seriesId.includes(':vwap')) {
      fifoCapacity = this.config.maxSmaPoints;
    }

    const dataSeries = new XyDataSeries(this.wasmContext, {
      dataSeriesName: name || seriesId,
      fifoCapacity,
      containsNaN: false,
      isSorted: true,
    });

    this.store.set(seriesId, {
      type: 'xy',
      dataSeries,
      lastMs: 0,
      count: 0,
    });

    return dataSeries;
  }

  /**
   * Get or create an OHLC data series
   */
  getOhlcSeries(seriesId: string, name?: string): OhlcDataSeries | null {
    if (!this.wasmContext) return null;

    const existing = this.store.get(seriesId);
    if (existing && existing.type === 'ohlc') {
      return existing.dataSeries as OhlcDataSeries;
    }

    const dataSeries = new OhlcDataSeries(this.wasmContext, {
      dataSeriesName: name || seriesId,
      fifoCapacity: this.config.maxBarPoints,
      containsNaN: false,
    });

    this.store.set(seriesId, {
      type: 'ohlc',
      dataSeries,
      lastMs: 0,
      count: 0,
    });

    return dataSeries;
  }

  /**
   * Check if a series exists
   */
  hasSeries(seriesId: string): boolean {
    return this.store.has(seriesId);
  }

  /**
   * Get series info
   */
  getSeriesInfo(seriesId: string): { count: number; lastMs: number } | null {
    const stored = this.store.get(seriesId);
    return stored ? { count: stored.count, lastMs: stored.lastMs } : null;
  }

  /**
   * Update series metadata after appending data
   */
  updateSeriesStats(seriesId: string, count: number, lastMs: number): void {
    const stored = this.store.get(seriesId);
    if (stored) {
      stored.count += count;
      stored.lastMs = Math.max(stored.lastMs, lastMs);
    }
  }

  /**
   * Get all series IDs
   */
  getAllSeriesIds(): string[] {
    return Array.from(this.store.keys());
  }

  /**
   * Get total point count across all series
   */
  getTotalPointCount(): number {
    let total = 0;
    for (const stored of this.store.values()) {
      total += stored.dataSeries.count();
    }
    return total;
  }

  /**
   * Clear all series data (keeps series objects)
   */
  clearAllData(): void {
    for (const stored of this.store.values()) {
      stored.dataSeries.clear();
      stored.count = 0;
      stored.lastMs = 0;
    }
  }

  /**
   * Delete and dispose all series
   */
  dispose(): void {
    for (const stored of this.store.values()) {
      stored.dataSeries.delete();
    }
    this.store.clear();
  }
}
