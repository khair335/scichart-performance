/**
 * SharedDataSeriesPool - Global data series manager that persists across layout changes
 * 
 * CRITICAL DESIGN PRINCIPLES:
 * 1. Data series are created ONCE and live forever (until explicitly cleared)
 * 2. Layout changes only affect RENDERING (which series appear in which pane)
 * 3. WebSocket data ingestion always updates the pool, regardless of layout
 * 4. When layout changes, we REUSE existing data series, never destroy them
 * 
 * This decouples data collection from visualization.
 */

import {
  XyDataSeries,
  OhlcDataSeries,
  TSciChart,
  EResamplingMode,
} from 'scichart';

export interface PooledDataSeries {
  dataSeries: XyDataSeries | OhlcDataSeries;
  seriesType: 'xy' | 'ohlc';
  seriesId: string;
  createdAt: number;
  lastUpdatedAt: number;
  /** Track if this series has ever received data */
  hasReceivedData: boolean;
}

interface PoolConfig {
  /** Default capacity for XY series (default: 2M) */
  xyCapacity: number;
  /** Default capacity for OHLC series (default: 500K) */
  ohlcCapacity: number;
  /** Enable FIFO mode for ring buffer behavior (default: true) */
  fifoEnabled: boolean;
}

const DEFAULT_POOL_CONFIG: PoolConfig = {
  xyCapacity: 2_000_000,
  ohlcCapacity: 500_000,
  fifoEnabled: true,
};

/**
 * Singleton data series pool that persists across React component lifecycle
 * 
 * Usage:
 * 1. Initialize with WASM context when SciChart loads
 * 2. Get/create data series by ID - always returns the same instance
 * 3. On layout change, just reconnect existing data series to new renderableSeries
 * 4. Data keeps flowing regardless of layout changes
 */
class SharedDataSeriesPool {
  private pool: Map<string, PooledDataSeries> = new Map();
  private wasmContext: TSciChart | null = null;
  private config: PoolConfig = { ...DEFAULT_POOL_CONFIG };
  private initialized = false;
  
  /** Listeners for data updates (for debugging/monitoring) */
  private dataUpdateListeners: Set<(seriesId: string, count: number) => void> = new Set();
  
  /**
   * Initialize the pool with a WASM context
   * Must be called once when SciChart initializes
   */
  initialize(wasm: TSciChart, config?: Partial<PoolConfig>): void {
    if (this.initialized && this.wasmContext === wasm) {
      // Already initialized with same context, just update config
      if (config) {
        this.config = { ...this.config, ...config };
      }
      return;
    }
    
    this.wasmContext = wasm;
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.initialized = true;
    console.log('[SharedDataSeriesPool] Initialized with config:', this.config);
  }
  
  /**
   * Check if pool is initialized
   */
  isInitialized(): boolean {
    return this.initialized && this.wasmContext !== null;
  }
  
  /**
   * Get WASM context
   */
  getWasmContext(): TSciChart | null {
    return this.wasmContext;
  }
  
  /**
   * Get or create a data series by ID
   * Always returns the same instance for a given ID
   */
  getOrCreate(seriesId: string, type: 'xy' | 'ohlc' = 'xy'): PooledDataSeries | null {
    if (!this.wasmContext) {
      console.warn('[SharedDataSeriesPool] Cannot create series: not initialized');
      return null;
    }
    
    // Return existing series if present
    if (this.pool.has(seriesId)) {
      return this.pool.get(seriesId)!;
    }
    
    // Create new series
    const now = Date.now();
    let dataSeries: XyDataSeries | OhlcDataSeries;
    
    try {
      if (type === 'ohlc') {
        dataSeries = new OhlcDataSeries(this.wasmContext, {
          dataSeriesName: seriesId,
          fifoCapacity: this.config.fifoEnabled ? this.config.ohlcCapacity : undefined,
          capacity: this.config.ohlcCapacity,
          containsNaN: false,
          dataIsSortedInX: true,
          dataEvenlySpacedInX: true,
        });
      } else {
        dataSeries = new XyDataSeries(this.wasmContext, {
          dataSeriesName: seriesId,
          fifoCapacity: this.config.fifoEnabled ? this.config.xyCapacity : undefined,
          capacity: this.config.xyCapacity,
          containsNaN: false,
          dataIsSortedInX: true,
          dataEvenlySpacedInX: true,
        });
      }
      
      const entry: PooledDataSeries = {
        dataSeries,
        seriesType: type,
        seriesId,
        createdAt: now,
        lastUpdatedAt: now,
        hasReceivedData: false,
      };
      
      this.pool.set(seriesId, entry);
      console.log(`[SharedDataSeriesPool] Created ${type} series: ${seriesId}`);
      
      return entry;
    } catch (e) {
      console.error(`[SharedDataSeriesPool] Error creating series ${seriesId}:`, e);
      return null;
    }
  }
  
  /**
   * Get an existing data series (returns null if not found)
   */
  get(seriesId: string): PooledDataSeries | null {
    return this.pool.get(seriesId) || null;
  }
  
  /**
   * Check if a series exists in the pool
   */
  has(seriesId: string): boolean {
    return this.pool.has(seriesId);
  }
  
  /**
   * Get all series IDs in the pool
   */
  getAllSeriesIds(): string[] {
    return Array.from(this.pool.keys());
  }
  
  /**
   * Get count of series in pool
   */
  get size(): number {
    return this.pool.size;
  }
  
  /**
   * Mark a series as having received data
   */
  markDataReceived(seriesId: string): void {
    const entry = this.pool.get(seriesId);
    if (entry) {
      entry.hasReceivedData = true;
      entry.lastUpdatedAt = Date.now();
    }
  }
  
  /**
   * Notify listeners of data update
   */
  notifyDataUpdate(seriesId: string): void {
    const entry = this.pool.get(seriesId);
    if (entry) {
      entry.lastUpdatedAt = Date.now();
      const count = entry.dataSeries.count();
      for (const listener of this.dataUpdateListeners) {
        try {
          listener(seriesId, count);
        } catch (e) {
          // Ignore listener errors
        }
      }
    }
  }
  
  /**
   * Add data update listener
   */
  addDataUpdateListener(listener: (seriesId: string, count: number) => void): () => void {
    this.dataUpdateListeners.add(listener);
    return () => {
      this.dataUpdateListeners.delete(listener);
    };
  }
  
  /**
   * Get statistics about the pool
   */
  getStats(): {
    totalSeries: number;
    seriesWithData: number;
    totalPoints: number;
    seriesBreakdown: { id: string; type: string; count: number }[];
  } {
    let totalPoints = 0;
    let seriesWithData = 0;
    const breakdown: { id: string; type: string; count: number }[] = [];
    
    for (const [id, entry] of this.pool) {
      const count = entry.dataSeries.count();
      totalPoints += count;
      if (count > 0) seriesWithData++;
      breakdown.push({
        id,
        type: entry.seriesType,
        count,
      });
    }
    
    return {
      totalSeries: this.pool.size,
      seriesWithData,
      totalPoints,
      seriesBreakdown: breakdown,
    };
  }
  
  /**
   * Clear all data from a specific series (but keep the series in pool)
   */
  clearSeriesData(seriesId: string): void {
    const entry = this.pool.get(seriesId);
    if (entry) {
      try {
        entry.dataSeries.clear();
        entry.hasReceivedData = false;
        console.log(`[SharedDataSeriesPool] Cleared data for: ${seriesId}`);
      } catch (e) {
        console.error(`[SharedDataSeriesPool] Error clearing series ${seriesId}:`, e);
      }
    }
  }
  
  /**
   * Clear all data from all series (but keep series in pool)
   */
  clearAllData(): void {
    for (const [seriesId, entry] of this.pool) {
      try {
        entry.dataSeries.clear();
        entry.hasReceivedData = false;
      } catch (e) {
        // Ignore errors during clear
      }
    }
    console.log('[SharedDataSeriesPool] Cleared all series data');
  }
  
  /**
   * Delete a series from the pool entirely
   * Use with caution - normally we want to keep series alive
   */
  delete(seriesId: string): void {
    const entry = this.pool.get(seriesId);
    if (entry) {
      try {
        entry.dataSeries.delete();
      } catch (e) {
        // Ignore deletion errors
      }
      this.pool.delete(seriesId);
      console.log(`[SharedDataSeriesPool] Deleted series: ${seriesId}`);
    }
  }
  
  /**
   * Reset the entire pool (use when component unmounts or app resets)
   * This deletes all data series and clears the pool
   */
  reset(): void {
    for (const [seriesId, entry] of this.pool) {
      try {
        entry.dataSeries.delete();
      } catch (e) {
        // Ignore deletion errors
      }
    }
    this.pool.clear();
    this.wasmContext = null;
    this.initialized = false;
    this.dataUpdateListeners.clear();
    console.log('[SharedDataSeriesPool] Pool reset');
  }
  
  /**
   * Iterate over all series
   */
  forEach(callback: (entry: PooledDataSeries, seriesId: string) => void): void {
    for (const [seriesId, entry] of this.pool) {
      callback(entry, seriesId);
    }
  }
  
  /**
   * Get entries as array
   */
  entries(): [string, PooledDataSeries][] {
    return Array.from(this.pool.entries());
  }
}

// Export singleton instance
export const sharedDataSeriesPool = new SharedDataSeriesPool();

// Also export class for testing
export { SharedDataSeriesPool };
