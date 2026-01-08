/**
 * Chart Logger Utility
 * 
 * Provides structured logging for debugging chart issues, especially:
 * - WASM memory errors (Aborted, memory access out of bounds)
 * - Surface lifecycle issues (seriesViewRect undefined)
 * - Performance violations (handler took Xms)
 * 
 * Logs are buffered and can be exported for debugging.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface LogEntry {
  timestamp: number;
  level: LogLevel;
  category: string;
  message: string;
  data?: any;
  stack?: string;
}

interface ChartLoggerConfig {
  /** Maximum number of log entries to keep in memory */
  maxEntries: number;
  /** Minimum log level to record */
  minLevel: LogLevel;
  /** Whether to also output to console */
  consoleOutput: boolean;
  /** Categories to include (empty = all) */
  includeCategories: string[];
  /** Categories to exclude */
  excludeCategories: string[];
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  critical: 4,
};

const DEFAULT_CONFIG: ChartLoggerConfig = {
  maxEntries: 5000,
  minLevel: 'info',
  consoleOutput: false, // Don't spam console by default
  includeCategories: [],
  excludeCategories: [],
};

class ChartLogger {
  private logs: LogEntry[] = [];
  private config: ChartLoggerConfig = { ...DEFAULT_CONFIG };
  private errorCounts: Map<string, number> = new Map();
  private lastErrorTime: Map<string, number> = new Map();
  
  /** Listeners for log events */
  private listeners: Set<(entry: LogEntry) => void> = new Set();
  
  /** Track WASM health status */
  private wasmHealthy = true;
  private wasmErrorCount = 0;
  private lastWasmError: string | null = null;

  configure(config: Partial<ChartLoggerConfig>): void {
    this.config = { ...this.config, ...config };
  }

  private shouldLog(level: LogLevel, category: string): boolean {
    // Check level
    if (LOG_LEVEL_PRIORITY[level] < LOG_LEVEL_PRIORITY[this.config.minLevel]) {
      return false;
    }
    
    // Check category filters
    if (this.config.includeCategories.length > 0) {
      if (!this.config.includeCategories.some(c => category.includes(c))) {
        return false;
      }
    }
    
    if (this.config.excludeCategories.some(c => category.includes(c))) {
      return false;
    }
    
    return true;
  }

  private addEntry(entry: LogEntry): void {
    this.logs.push(entry);
    
    // Trim old entries if over limit
    if (this.logs.length > this.config.maxEntries) {
      this.logs = this.logs.slice(-Math.floor(this.config.maxEntries * 0.9));
    }
    
    // Notify listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (e) {
        // Ignore listener errors
      }
    }
    
    // Console output if enabled
    if (this.config.consoleOutput) {
      const prefix = `[${entry.category}]`;
      switch (entry.level) {
        case 'debug':
          console.debug(prefix, entry.message, entry.data || '');
          break;
        case 'info':
          console.info(prefix, entry.message, entry.data || '');
          break;
        case 'warn':
          console.warn(prefix, entry.message, entry.data || '');
          break;
        case 'error':
        case 'critical':
          console.error(prefix, entry.message, entry.data || '', entry.stack || '');
          break;
      }
    }
  }

  log(level: LogLevel, category: string, message: string, data?: any): void {
    if (!this.shouldLog(level, category)) return;
    
    const entry: LogEntry = {
      timestamp: Date.now(),
      level,
      category,
      message,
      data: data ? this.sanitizeData(data) : undefined,
    };
    
    this.addEntry(entry);
  }

  debug(category: string, message: string, data?: any): void {
    this.log('debug', category, message, data);
  }

  info(category: string, message: string, data?: any): void {
    this.log('info', category, message, data);
  }

  warn(category: string, message: string, data?: any): void {
    this.log('warn', category, message, data);
  }

  error(category: string, message: string, error?: Error | any, data?: any): void {
    // Track error frequency
    const errorKey = `${category}:${message}`;
    const count = (this.errorCounts.get(errorKey) || 0) + 1;
    this.errorCounts.set(errorKey, count);
    this.lastErrorTime.set(errorKey, Date.now());
    
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: 'error',
      category,
      message: `${message} (occurrence #${count})`,
      data: data ? this.sanitizeData(data) : undefined,
      stack: error?.stack || (error instanceof Error ? error.message : String(error)),
    };
    
    this.addEntry(entry);
    
    // Check for WASM-related errors
    this.checkWasmError(message, error);
  }

  critical(category: string, message: string, error?: Error | any, data?: any): void {
    const entry: LogEntry = {
      timestamp: Date.now(),
      level: 'critical',
      category,
      message,
      data: data ? this.sanitizeData(data) : undefined,
      stack: error?.stack || (error instanceof Error ? error.message : String(error)),
    };
    
    this.addEntry(entry);
    
    // Always log critical to console
    console.error(`[CRITICAL][${category}]`, message, error, data);
    
    // Check for WASM-related errors
    this.checkWasmError(message, error);
  }

  private checkWasmError(message: string, error?: any): void {
    const errorStr = String(error?.message || error || message).toLowerCase();
    
    const isWasmError = 
      errorStr.includes('aborted') ||
      errorStr.includes('memory access out of bounds') ||
      errorStr.includes('function signature mismatch') ||
      errorStr.includes('wasm') ||
      errorStr.includes('scichart2d.wasm');
    
    if (isWasmError) {
      this.wasmHealthy = false;
      this.wasmErrorCount++;
      this.lastWasmError = message;
      
      this.addEntry({
        timestamp: Date.now(),
        level: 'critical',
        category: 'WASM',
        message: `WASM error detected (total: ${this.wasmErrorCount}): ${message}`,
        data: { wasmErrorCount: this.wasmErrorCount },
      });
    }
  }

  /**
   * Check if a surface is valid and safe to use
   */
  isSurfaceValid(surface: any, context: string): boolean {
    if (!surface) {
      this.warn('Surface', `${context}: surface is null/undefined`);
      return false;
    }
    
    try {
      // Check if surface has been deleted
      if ((surface as any).isDeleted) {
        this.warn('Surface', `${context}: surface is deleted`);
        return false;
      }
      
      // Try to access a property to verify surface is valid
      const _ = surface.id;
      
      // Check for seriesViewRect (the error from console)
      if (surface.seriesViewRect === undefined) {
        this.warn('Surface', `${context}: seriesViewRect is undefined`);
        return false;
      }
      
      return true;
    } catch (e) {
      this.error('Surface', `${context}: surface access error`, e);
      return false;
    }
  }

  /**
   * Check if WASM is healthy
   */
  isWasmHealthy(): boolean {
    return this.wasmHealthy;
  }

  /**
   * Get WASM error count
   */
  getWasmErrorCount(): number {
    return this.wasmErrorCount;
  }

  /**
   * Reset WASM health status (e.g., after recovery)
   */
  resetWasmHealth(): void {
    this.wasmHealthy = true;
    this.wasmErrorCount = 0;
    this.lastWasmError = null;
    this.info('WASM', 'WASM health status reset');
  }

  /**
   * Get all logs
   */
  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  /**
   * Get logs by level
   */
  getLogsByLevel(level: LogLevel): LogEntry[] {
    return this.logs.filter(l => l.level === level);
  }

  /**
   * Get logs by category
   */
  getLogsByCategory(category: string): LogEntry[] {
    return this.logs.filter(l => l.category.includes(category));
  }

  /**
   * Get recent errors
   */
  getRecentErrors(count: number = 50): LogEntry[] {
    return this.logs
      .filter(l => l.level === 'error' || l.level === 'critical')
      .slice(-count);
  }

  /**
   * Get error frequency map
   */
  getErrorFrequency(): Map<string, number> {
    return new Map(this.errorCounts);
  }

  /**
   * Export logs as JSON string
   */
  exportLogs(): string {
    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      wasmHealth: {
        healthy: this.wasmHealthy,
        errorCount: this.wasmErrorCount,
        lastError: this.lastWasmError,
      },
      errorFrequency: Object.fromEntries(this.errorCounts),
      logs: this.logs,
    }, null, 2);
  }

  /**
   * Download logs as file
   */
  downloadLogs(filename?: string): void {
    const content = this.exportLogs();
    const blob = new Blob([content], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || `chart-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Clear all logs
   */
  clear(): void {
    this.logs = [];
    this.errorCounts.clear();
    this.lastErrorTime.clear();
    this.info('Logger', 'Logs cleared');
  }

  /**
   * Add log listener
   */
  addListener(listener: (entry: LogEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Get summary of log state
   */
  getSummary(): {
    totalLogs: number;
    byLevel: Record<LogLevel, number>;
    wasmHealthy: boolean;
    wasmErrorCount: number;
    topErrors: Array<{ key: string; count: number }>;
  } {
    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      critical: 0,
    };
    
    for (const log of this.logs) {
      byLevel[log.level]++;
    }
    
    const topErrors = Array.from(this.errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([key, count]) => ({ key, count }));
    
    return {
      totalLogs: this.logs.length,
      byLevel,
      wasmHealthy: this.wasmHealthy,
      wasmErrorCount: this.wasmErrorCount,
      topErrors,
    };
  }

  /**
   * Sanitize data for logging (remove circular refs, limit size)
   */
  private sanitizeData(data: any, depth: number = 0): any {
    if (depth > 3) return '[max depth]';
    
    if (data === null || data === undefined) return data;
    
    if (typeof data === 'function') return '[function]';
    
    if (typeof data !== 'object') return data;
    
    // Handle arrays
    if (Array.isArray(data)) {
      if (data.length > 100) {
        return `[Array(${data.length}) - truncated]`;
      }
      return data.slice(0, 100).map(item => this.sanitizeData(item, depth + 1));
    }
    
    // Handle objects
    try {
      const result: Record<string, any> = {};
      const keys = Object.keys(data).slice(0, 50);
      for (const key of keys) {
        // Skip internal properties
        if (key.startsWith('_')) continue;
        result[key] = this.sanitizeData(data[key], depth + 1);
      }
      return result;
    } catch (e) {
      return '[object - could not serialize]';
    }
  }
}

// Singleton instance
export const chartLogger = new ChartLogger();

// Export class for testing
export { ChartLogger };

// Convenience function for wrapping operations with error handling
export function safeChartOperation<T>(
  category: string,
  operation: string,
  fn: () => T,
  fallback?: T
): T | undefined {
  try {
    return fn();
  } catch (e) {
    chartLogger.error(category, `${operation} failed`, e);
    return fallback;
  }
}

// Convenience function for async operations
export async function safeAsyncChartOperation<T>(
  category: string,
  operation: string,
  fn: () => Promise<T>,
  fallback?: T
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    chartLogger.error(category, `${operation} failed`, e);
    return fallback;
  }
}
