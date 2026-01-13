/**
 * SciChart crash hooks
 *
 * SciChart can sometimes catch-and-log errors (e.g. "Error from chart in div ...")
 * rather than letting them bubble to window.onerror.
 *
 * This file installs:
 * - console.error interceptor for SciChart/WASM errors
 * - window.onerror + unhandledrejection handlers
 * - automatic crash snapshot persistence (localStorage) for post-mortem export
 */

import { chartLogger } from '@/lib/chart-logger';

type AnyArgs = any[];

function isSciChartOrWasmErrorText(text: string): boolean {
  const t = text.toLowerCase();
  return (
    t.includes('error from chart in div') ||
    t.includes('scichart2d.wasm') ||
    t.includes('memory access out of bounds') ||
    t.includes('function signature mismatch') ||
    t.includes('table index is out of bounds') ||
    t.includes('aborted()') ||
    t.includes('seriesviewrect')
  );
}

function extractFirstError(args: AnyArgs): Error | undefined {
  for (const a of args) {
    if (a instanceof Error) return a;
  }
  return undefined;
}

function stringifyConsoleArgs(args: AnyArgs): string {
  try {
    return args
      .map(a => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return a.message;
        if (typeof a === 'object') return JSON.stringify(a);
        return String(a);
      })
      .join(' ')
      .slice(0, 2000);
  } catch {
    return '[unserializable console args]';
  }
}

export function installSciChartCrashHooks(): void {
  if (typeof window === 'undefined') return;

  // Idempotent install (important for Vite HMR)
  if ((window as any).__sciChartCrashHooksInstalled) return;
  (window as any).__sciChartCrashHooksInstalled = true;

  // Expose logger for debugging
  (window as any).chartLogger = chartLogger;

  // --- console.error tap ---
  const originalConsoleError = console.error.bind(console);
  console.error = (...args: AnyArgs) => {
    try {
      const msg = stringifyConsoleArgs(args);
      if (isSciChartOrWasmErrorText(msg)) {
        const err = extractFirstError(args);
        chartLogger.critical('SciChart', 'console.error captured SciChart/WASM error', err ?? msg, {
          message: msg,
          breadcrumbs: chartLogger.getBreadcrumbs().slice(-50),
        });
        // Persist snapshot so it survives reload
        chartLogger.saveCrashSnapshot('chart-logs:lastCrash', `console.error: ${msg.slice(0, 300)}`);
      }
    } catch {
      // Never block console
    }
    originalConsoleError(...args);
  };

  // --- window.onerror ---
  window.addEventListener('error', (event) => {
    try {
      const errorStr = String((event as any).error?.message || event.message || '');
      if (!isSciChartOrWasmErrorText(errorStr)) return;

      chartLogger.critical('GlobalError', 'window.error captured SciChart/WASM error', (event as any).error ?? errorStr, {
        message: event.message,
        filename: (event as any).filename,
        lineno: (event as any).lineno,
        colno: (event as any).colno,
        breadcrumbs: chartLogger.getBreadcrumbs().slice(-50),
      });
      chartLogger.saveCrashSnapshot('chart-logs:lastCrash', `window.error: ${errorStr.slice(0, 300)}`);
    } catch {
      // Ignore
    }
  });

  // --- unhandledrejection ---
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
    try {
      const reason = (event as any).reason;
      const errorStr = String(reason?.message || reason || '');
      if (!isSciChartOrWasmErrorText(errorStr)) return;

      chartLogger.critical('GlobalError', 'unhandledrejection captured SciChart/WASM error', reason ?? errorStr, {
        message: errorStr,
        breadcrumbs: chartLogger.getBreadcrumbs().slice(-50),
      });
      chartLogger.saveCrashSnapshot('chart-logs:lastCrash', `unhandledrejection: ${errorStr.slice(0, 300)}`);
    } catch {
      // Ignore
    }
  });

  // Helpful console hint
  console.info(
    '[SciChartCrashHooks] Installed. Use window.chartLogger.downloadLogs() or window.chartLogger.downloadLastCrashSnapshot()'
  );
}
