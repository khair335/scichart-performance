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
} from 'scichart';

import { chartLogger } from '@/lib/chart-logger';

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
   * 
   * CRITICAL: If called with a DIFFERENT wasm context (e.g., after layout change),
   * we need to migrate existing data to new DataSeries created with the new context.
   */
  initialize(wasm: TSciChart, config?: Partial<PoolConfig>): void {
    if (this.initialized && this.wasmContext === wasm) {
      // Already initialized with same context, just update config
      if (config) {
        this.config = { ...this.config, ...config };
      }
      return;
    }
    
    // CRITICAL: Check if we have a DIFFERENT wasm context (layout change scenario)
    // In this case, existing DataSeries are invalid and we need to migrate data
    const hadPreviousContext = this.wasmContext !== null && this.wasmContext !== wasm;
    const previousPool = hadPreviousContext ? new Map(this.pool) : null;
    
    if (hadPreviousContext) {
      console.log(`[SharedDataSeriesPool] WASM context changed - migrating ${this.pool.size} series to new context`);
      // Clear the old pool (don't delete DataSeries as they're tied to deleted WASM)
      this.pool.clear();
    }
    
    this.wasmContext = wasm;
    if (config) {
      this.config = { ...this.config, ...config };
    }
    this.initialized = true;
    console.log('[SharedDataSeriesPool] Initialized with config:', this.config);
    
    // Migrate data from old series to new series
    if (previousPool && previousPool.size > 0) {
      for (const [seriesId, oldEntry] of previousPool) {
        try {
          // Check if old series is still valid and has data
          let hasData = false;
          let dataCount = 0;
          try {
            dataCount = oldEntry.dataSeries.count();
            hasData = dataCount > 0 && oldEntry.hasReceivedData;
          } catch (e) {
            // Old series is invalid (expected - old WASM context was deleted)
            hasData = false;
          }
          
          if (hasData) {
            // Create new series with same type
            const newEntry = this.getOrCreate(seriesId, oldEntry.seriesType);
            if (newEntry) {
              try {
                // Copy data from old series to new series
                if (oldEntry.seriesType === 'ohlc' && oldEntry.dataSeries instanceof OhlcDataSeries) {
                  const oldOhlc = oldEntry.dataSeries as OhlcDataSeries;
                  const newOhlc = newEntry.dataSeries as OhlcDataSeries;
                  
                  const xValues = oldOhlc.getNativeXValues();
                  const oValues = oldOhlc.getNativeOpenValues();
                  const hValues = oldOhlc.getNativeHighValues();
                  const lValues = oldOhlc.getNativeLowValues();
                  const cValues = oldOhlc.getNativeCloseValues();
                  
                  if (xValues && oValues && hValues && lValues && cValues && xValues.size() > 0) {
                    const len = xValues.size();
                    const xArr = new Float64Array(len);
                    const oArr = new Float64Array(len);
                    const hArr = new Float64Array(len);
                    const lArr = new Float64Array(len);
                    const cArr = new Float64Array(len);
                    
                    for (let i = 0; i < len; i++) {
                      xArr[i] = xValues.get(i);
                      oArr[i] = oValues.get(i);
                      hArr[i] = hValues.get(i);
                      lArr[i] = lValues.get(i);
                      cArr[i] = cValues.get(i);
                    }
                    
                    newOhlc.appendRange(xArr, oArr, hArr, lArr, cArr);
                    newEntry.hasReceivedData = true;
                    console.log(`[SharedDataSeriesPool] ✅ Migrated OHLC series: ${seriesId} (${len} points)`);
                  }
                } else if (oldEntry.dataSeries instanceof XyDataSeries) {
                  const oldXy = oldEntry.dataSeries as XyDataSeries;
                  const newXy = newEntry.dataSeries as XyDataSeries;
                  
                  const xValues = oldXy.getNativeXValues();
                  const yValues = oldXy.getNativeYValues();
                  
                  if (xValues && yValues && xValues.size() > 0) {
                    const len = xValues.size();
                    const xArr = new Float64Array(len);
                    const yArr = new Float64Array(len);
                    
                    for (let i = 0; i < len; i++) {
                      xArr[i] = xValues.get(i);
                      yArr[i] = yValues.get(i);
                    }
                    
                    newXy.appendRange(xArr, yArr);
                    newEntry.hasReceivedData = true;
                    console.log(`[SharedDataSeriesPool] ✅ Migrated XY series: ${seriesId} (${len} points)`);
                  }
                }
              } catch (copyError) {
                // Old series data is no longer accessible (expected if WASM was deleted)
                console.warn(`[SharedDataSeriesPool] Could not migrate data for ${seriesId}:`, copyError);
              }
            }
          } else {
            // No data to migrate, just create empty entry for future use
            console.log(`[SharedDataSeriesPool] Skipping empty series: ${seriesId}`);
          }
        } catch (e) {
          console.warn(`[SharedDataSeriesPool] Error migrating series ${seriesId}:`, e);
        }
      }
    }
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
          // IMPORTANT:
          // Do NOT set dataEvenlySpacedInX=true for real-time market data.
          // Tick/indicator timestamps are almost always unevenly spaced.
          // Incorrectly enabling evenly-spaced optimizations can cause SciChart's
          // native resamplers to compute invalid indices, which may surface as
          // "RuntimeError: memory access out of bounds" inside scichart2d.wasm.
          dataEvenlySpacedInX: false,
        });
      } else {
        dataSeries = new XyDataSeries(this.wasmContext, {
          dataSeriesName: seriesId,
          fifoCapacity: this.config.fifoEnabled ? this.config.xyCapacity : undefined,
          capacity: this.config.xyCapacity,
          containsNaN: false,
          dataIsSortedInX: true,
          // IMPORTANT: see comment above (OHLC). Real-time market data is rarely
          // evenly spaced in X. Keep this false to avoid resampler assumptions.
          dataEvenlySpacedInX: false,
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

      // Record in ChartLogger for crash forensics (low volume: creation happens rarely)
      chartLogger.info('DataSeriesPool', `Created ${type} series`, {
        seriesId,
        seriesType: type,
        fifoEnabled: this.config.fifoEnabled,
        fifoCapacity: this.config.fifoEnabled
          ? (type === 'ohlc' ? this.config.ohlcCapacity : this.config.xyCapacity)
          : undefined,
        capacity: type === 'ohlc' ? this.config.ohlcCapacity : this.config.xyCapacity,
        dataIsSortedInX: true,
        dataEvenlySpacedInX: false,
      });
      
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
