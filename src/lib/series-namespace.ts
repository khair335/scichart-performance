/**
 * Series namespace utilities based on DATA.NAMESPACE.md
 * 
 * Namespace pattern: <instrument>:<kind>[:qualifiers...]
 * 
 * Examples:
 * - Tick: ES.c.0:ticks
 * - Tick indicator: ES.c.0:sma_10, ES.c.0:vwap
 * - OHLC bar: ES.c.0:ohlc_time:10000
 * - Bar indicator: ES.c.0:ohlc_time:10000:rsi
 * - Strategy: ES.c.0:strategy:alpha:markers, ES.c.0:strategy:alpha:pnl
 */

export type SeriesType = 'tick' | 'tick-indicator' | 'ohlc-bar' | 'bar-indicator' | 'strategy-marker' | 'strategy-signal' | 'strategy-pnl' | 'other';

export interface SeriesTypeInfo {
  type: SeriesType;
  isIndicator: boolean;
  isTickIndicator: boolean; // Indicator that goes on tick chart
  isBarIndicator: boolean;   // Indicator that goes on OHLC chart
  chartTarget: 'tick' | 'ohlc' | 'none'; // Which chart should this series be plotted on
}

/**
 * Parse series ID to determine its type and chart target
 */
export function parseSeriesType(seriesId: string): SeriesTypeInfo {
  // Strategy series
  if (seriesId.includes(':strategy:')) {
    if (seriesId.includes(':pnl')) {
      return {
        type: 'strategy-pnl',
        isIndicator: false,
        isTickIndicator: false,
        isBarIndicator: false,
        chartTarget: 'tick', // PnL is plotted as a regular series (PnL pane via layout)
      };
    }
    if (seriesId.includes(':signals')) {
      return {
        type: 'strategy-signal',
        isIndicator: false,
        isTickIndicator: false,
        isBarIndicator: false,
        chartTarget: 'none', // Signals are rendered as annotations only, never as chart series
      };
    }
    if (seriesId.includes(':markers')) {
      return {
        type: 'strategy-marker',
        isIndicator: false,
        isTickIndicator: false,
        isBarIndicator: false,
        chartTarget: 'none', // Markers are rendered as annotations only, never as chart series
      };
    }
    return {
      type: 'other',
      isIndicator: false,
      isTickIndicator: false,
      isBarIndicator: false,
      chartTarget: 'none',
    };
  }

  // Tick data
  if (seriesId.includes(':ticks')) {
    return {
      type: 'tick',
      isIndicator: false,
      isTickIndicator: false,
      isBarIndicator: false,
      chartTarget: 'tick',
    };
  }

  // OHLC series
  if (seriesId.includes(':ohlc_')) {
    // Check if it's a bar indicator (has additional qualifiers after the interval)
    // Pattern: ES.c.0:ohlc_time:10000:rsi
    // Split by ':' and check if there are more than 4 parts (instrument:part1:part2:ohlc_time:interval:indicator)
    const parts = seriesId.split(':');
    const ohlcIndex = parts.findIndex(p => p.startsWith('ohlc_'));
    
    if (ohlcIndex >= 0 && parts.length > ohlcIndex + 2) {
      // Has qualifiers after the interval = bar indicator
      return {
        type: 'bar-indicator',
        isIndicator: true,
        isTickIndicator: false,
        isBarIndicator: true,
        chartTarget: 'ohlc',
      };
    } else {
      // No qualifiers after interval = OHLC bar
      return {
        type: 'ohlc-bar',
        isIndicator: false,
        isTickIndicator: false,
        isBarIndicator: false,
        chartTarget: 'ohlc',
      };
    }
  }

  // If it doesn't contain :ohlc_ or :strategy:, it's likely a tick indicator
  // Examples: ES.c.0:sma_10, ES.c.0:vwap, ES.c.0:ema_20
  return {
    type: 'tick-indicator',
    isIndicator: true,
    isTickIndicator: true,
    isBarIndicator: false,
    chartTarget: 'tick',
  };
}

/**
 * Get display type name for UI grouping
 */
export function getDisplayType(seriesId: string): string {
  const info = parseSeriesType(seriesId);
  
  switch (info.type) {
    case 'tick':
      return 'Tick';
    case 'tick-indicator':
    case 'bar-indicator':
      return 'Indicator';
    case 'ohlc-bar':
      return 'OHLC';
    case 'strategy-pnl':
      return 'PnL';
    case 'strategy-signal':
      return 'Signal';
    case 'strategy-marker':
      return 'Marker';
    default:
      return 'Other';
  }
}

/**
 * Check if a series is an indicator (tick or bar)
 */
export function isIndicator(seriesId: string): boolean {
  return parseSeriesType(seriesId).isIndicator;
}

/**
 * Check if a series should be plotted on the tick chart
 */
export function isTickChartSeries(seriesId: string): boolean {
  return parseSeriesType(seriesId).chartTarget === 'tick';
}

/**
 * Check if a series should be plotted on the OHLC chart
 */
export function isOhlcChartSeries(seriesId: string): boolean {
  return parseSeriesType(seriesId).chartTarget === 'ohlc';
}




