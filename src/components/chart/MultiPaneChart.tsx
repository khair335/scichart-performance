import { useEffect, useRef, useState, useCallback } from 'react';
import {
  SciChartSurface,
  NumericAxis,
  DateTimeNumericAxis,
  FastLineRenderableSeries,
  
  FastCandlestickRenderableSeries,
  FastMountainRenderableSeries,
  
  XyDataSeries,
  
  OhlcDataSeries,

  ZoomPanModifier,
  ZoomExtentsModifier,
  
  MouseWheelZoomModifier,
  
  RubberBandXyZoomModifier,
  
  XAxisDragModifier,
  YAxisDragModifier,
  NumberRange,
  EAutoRange,
  SciChartVerticalGroup,
  TSciChart,
  EAxisAlignment,
  CursorModifier,
  RolloverModifier,
  LegendModifier,
  EXyDirection,
  SciChartOverview,
  SciChartDefaults,
  DpiHelper,
  EResamplingMode,
  EExecuteOn,
  // Official SciChart minimap range selection modifier
  OverviewRangeSelectionModifier,
  TextAnnotation,
  ECoordinateMode,
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  EllipsePointMarker,
  ESearchMode,
} from 'scichart';
import type { Sample } from '@/lib/wsfeed-client';
import { defaultChartConfig } from '@/types/chart';
import { parseSeriesType, isTickChartSeries, isOhlcChartSeries } from '@/lib/series-namespace';
import { PlotLayoutManager } from '@/lib/plot-layout-manager';
import type { ParsedLayout, PlotLayout } from '@/types/plot-layout';
import { DynamicPaneManager, type PaneSurface as DynamicPaneSurface } from '@/lib/dynamic-pane-manager';
import { renderHorizontalLines, renderVerticalLines, calculateYRangeWithHLines, getHLineYValues } from '@/lib/overlay-renderer';
import { groupStrategyMarkers, getConsolidatedSeriesId, type MarkerGroup } from '@/lib/strategy-marker-consolidator';
import { parseMarkerFromSample, type MarkerData } from '@/lib/strategy-marker-renderer';
import { 
  createAllMarkerScatterSeries, 
  getMarkerSeriesType, 
  createEmptyMarkerBatches,
  type MarkerSeriesType,
  type MarkerScatterGroup 
} from '@/lib/strategy-marker-scatter';
import { sharedDataSeriesPool, type PooledDataSeries } from '@/lib/shared-data-series-pool';
import { chartLogger, safeChartOperation } from '@/lib/chart-logger';
import { interpolateYValue } from '@/lib/interpolate-y-value';

import { formatInTimeZone } from 'date-fns-tz';

/**
 * Formats a timestamp value to date string with time and milliseconds in a specific timezone
 * Uses date-fns-tz for proper IANA timezone support (e.g., 'America/Chicago')
 */
function formatDateTimeWithMilliseconds(dataValue: number, timezone: string = 'UTC'): string {
  // DateTimeNumericAxis uses milliseconds internally, but check if we need to convert
  // If value is very small (< year 2000 in ms), it might be in seconds
  let timestamp = dataValue;
  if (dataValue < 946684800000) { // Less than 2000-01-01 in milliseconds
    timestamp = dataValue * 1000; // Convert seconds to milliseconds
  }
  
  const date = new Date(timestamp);
  
  // Use date-fns-tz for proper timezone conversion
  // Format as: YYYY-MM-DD HH:mm:ss.SSS
  return formatInTimeZone(date, timezone, 'yyyy-MM-dd HH:mm:ss.SSS');
}

/**
 * Creates a formatter function with the specified timezone bound
 */
function createTimezoneFormatter(timezone: string): (dataValue: number) => string {
  return (dataValue: number) => formatDateTimeWithMilliseconds(dataValue, timezone);
}

/**
 * Custom label provider wrapper that formats dates with time and milliseconds for cursor labels
 * Preserves all original labelProvider methods while overriding formatLabel and formatCursorLabel
 */
function createCursorLabelProvider(originalLabelProvider: any, timezone: string = 'UTC') {
  const formatter = createTimezoneFormatter(timezone);
  
  if (!originalLabelProvider) {
    // If no original provider, return a minimal implementation
    return {
      formatLabel: formatter,
      formatCursorLabel: formatter,
    };
  }
  
  // Store original methods if not already stored
  if (!(originalLabelProvider as any)._originalFormatLabel) {
    (originalLabelProvider as any)._originalFormatLabel = originalLabelProvider.formatLabel;
    (originalLabelProvider as any)._originalFormatCursorLabel = originalLabelProvider.formatCursorLabel;
  }
  
  // Directly override the methods on the original provider object
  originalLabelProvider.formatLabel = formatter;
  if (originalLabelProvider.formatCursorLabel !== undefined) {
    originalLabelProvider.formatCursorLabel = formatter;
  }
  
  return originalLabelProvider;
}

/**
 * Restores the original label provider methods
 */
function restoreOriginalLabelProvider(labelProvider: any) {
  if (!labelProvider) return;
  
  if ((labelProvider as any)._originalFormatLabel) {
    labelProvider.formatLabel = (labelProvider as any)._originalFormatLabel;
    delete (labelProvider as any)._originalFormatLabel;
  }
  
  if ((labelProvider as any)._originalFormatCursorLabel) {
    labelProvider.formatCursorLabel = (labelProvider as any)._originalFormatCursorLabel;
    delete (labelProvider as any)._originalFormatCursorLabel;
  }
}

type BatchSanitizationStats = {
  seriesId: string;
  type: 'xy' | 'ohlc';
  inCount: number;
  outCount: number;
  droppedNonFinite: number;
  droppedOutOfOrder: number;
  prevX?: number;
  firstX?: number;
  lastX?: number;
  minDx?: number;
  maxDx?: number;
};

function sanitizeSortedXyBatch(
  seriesId: string,
  x: number[],
  y: number[],
  prevX: number | undefined
): {
  x: number[];
  y: number[];
  stats: BatchSanitizationStats;
  nextX: number | undefined;
  changed: boolean;
} {
  const n = x.length;
  let droppedNonFinite = 0;
  let droppedOutOfOrder = 0;
  let needsFilter = false;

  // First pass: detect if we need filtering while computing stats
  let last = prevX ?? -Infinity;
  let minDx = Infinity;
  let maxDx = -Infinity;
  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) {
      droppedNonFinite++;
      needsFilter = true;
      continue;
    }
    if (xi < last) {
      droppedOutOfOrder++;
      needsFilter = true;
      continue;
    }
    if (Number.isFinite(last) && last !== -Infinity) {
      const dx = xi - last;
      if (dx < minDx) minDx = dx;
      if (dx > maxDx) maxDx = dx;
    }
    last = xi;
  }

  if (!needsFilter) {
    const firstX = n > 0 ? x[0] : undefined;
    const lastX = n > 0 ? x[n - 1] : undefined;
    const stats: BatchSanitizationStats = {
      seriesId,
      type: 'xy',
      inCount: n,
      outCount: n,
      droppedNonFinite: 0,
      droppedOutOfOrder: 0,
      prevX,
      firstX,
      lastX,
      minDx: Number.isFinite(minDx) ? minDx : undefined,
      maxDx: Number.isFinite(maxDx) ? maxDx : undefined,
    };
    return { x, y, stats, nextX: lastX ?? prevX, changed: false };
  }

  // Second pass: filter to monotonic + finite
  const x2: number[] = [];
  const y2: number[] = [];
  last = prevX ?? -Infinity;
  minDx = Infinity;
  maxDx = -Infinity;
  let firstKept: number | undefined;
  let lastKept: number | undefined;

  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const yi = y[i];
    if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
    if (xi < last) continue;

    if (Number.isFinite(last) && last !== -Infinity) {
      const dx = xi - last;
      if (dx < minDx) minDx = dx;
      if (dx > maxDx) maxDx = dx;
    }

    if (firstKept === undefined) firstKept = xi;
    x2.push(xi);
    y2.push(yi);
    last = xi;
    lastKept = xi;
  }

  const stats: BatchSanitizationStats = {
    seriesId,
    type: 'xy',
    inCount: n,
    outCount: x2.length,
    droppedNonFinite,
    droppedOutOfOrder,
    prevX,
    firstX: firstKept,
    lastX: lastKept,
    minDx: Number.isFinite(minDx) ? minDx : undefined,
    maxDx: Number.isFinite(maxDx) ? maxDx : undefined,
  };

  return { x: x2, y: y2, stats, nextX: lastKept ?? prevX, changed: true };
}

function sanitizeSortedOhlcBatch(
  seriesId: string,
  x: number[],
  o: number[],
  h: number[],
  l: number[],
  c: number[],
  prevX: number | undefined
): {
  x: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  stats: BatchSanitizationStats;
  nextX: number | undefined;
  changed: boolean;
} {
  const n = x.length;
  let droppedNonFinite = 0;
  let droppedOutOfOrder = 0;
  let needsFilter = false;

  let last = prevX ?? -Infinity;
  let minDx = Infinity;
  let maxDx = -Infinity;

  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const oi = o[i];
    const hi = h[i];
    const li = l[i];
    const ci = c[i];

    if (
      !Number.isFinite(xi) ||
      !Number.isFinite(oi) ||
      !Number.isFinite(hi) ||
      !Number.isFinite(li) ||
      !Number.isFinite(ci)
    ) {
      droppedNonFinite++;
      needsFilter = true;
      continue;
    }
    if (xi < last) {
      droppedOutOfOrder++;
      needsFilter = true;
      continue;
    }
    if (Number.isFinite(last) && last !== -Infinity) {
      const dx = xi - last;
      if (dx < minDx) minDx = dx;
      if (dx > maxDx) maxDx = dx;
    }
    last = xi;
  }

  if (!needsFilter) {
    const firstX = n > 0 ? x[0] : undefined;
    const lastX = n > 0 ? x[n - 1] : undefined;
    const stats: BatchSanitizationStats = {
      seriesId,
      type: 'ohlc',
      inCount: n,
      outCount: n,
      droppedNonFinite: 0,
      droppedOutOfOrder: 0,
      prevX,
      firstX,
      lastX,
      minDx: Number.isFinite(minDx) ? minDx : undefined,
      maxDx: Number.isFinite(maxDx) ? maxDx : undefined,
    };
    return { x, o, h, l, c, stats, nextX: lastX ?? prevX, changed: false };
  }

  const x2: number[] = [];
  const o2: number[] = [];
  const h2: number[] = [];
  const l2: number[] = [];
  const c2: number[] = [];

  last = prevX ?? -Infinity;
  minDx = Infinity;
  maxDx = -Infinity;
  let firstKept: number | undefined;
  let lastKept: number | undefined;

  for (let i = 0; i < n; i++) {
    const xi = x[i];
    const oi = o[i];
    const hi = h[i];
    const li = l[i];
    const ci = c[i];

    if (
      !Number.isFinite(xi) ||
      !Number.isFinite(oi) ||
      !Number.isFinite(hi) ||
      !Number.isFinite(li) ||
      !Number.isFinite(ci)
    ) {
      continue;
    }
    if (xi < last) continue;

    if (Number.isFinite(last) && last !== -Infinity) {
      const dx = xi - last;
      if (dx < minDx) minDx = dx;
      if (dx > maxDx) maxDx = dx;
    }

    if (firstKept === undefined) firstKept = xi;
    x2.push(xi);
    o2.push(oi);
    h2.push(hi);
    l2.push(li);
    c2.push(ci);
    last = xi;
    lastKept = xi;
  }

  const stats: BatchSanitizationStats = {
    seriesId,
    type: 'ohlc',
    inCount: n,
    outCount: x2.length,
    droppedNonFinite,
    droppedOutOfOrder,
    prevX,
    firstX: firstKept,
    lastX: lastKept,
    minDx: Number.isFinite(minDx) ? minDx : undefined,
    maxDx: Number.isFinite(maxDx) ? maxDx : undefined,
  };

  return { x: x2, o: o2, h: h2, l: l2, c: c2, stats, nextX: lastKept ?? prevX, changed: true };
}

/**
 * Zoom Y-axis to fit data AND hlines for a pane
 * This extends the standard zoomExtentsY behavior to include hline Y values
 */
function zoomExtentsYWithHLines(surface: SciChartSurface, paneId: string): void {
  try {
    // First, get the current data range by calling zoomExtentsY
    surface.zoomExtentsY();
    
    // Get hline Y values for this pane
    const hlineYs = getHLineYValues(paneId);
    if (hlineYs.length === 0) {
      // No hlines, standard zoom is sufficient
      return;
    }
    
    // Get the current Y-axis range after zoomExtentsY
    const yAxis = surface.yAxes.get(0);
    if (!yAxis) return;
    
    const currentRange = yAxis.visibleRange;
    if (!currentRange || !isFinite(currentRange.min) || !isFinite(currentRange.max)) return;
    
    // Calculate new range that includes hlines
    let newMin = currentRange.min;
    let newMax = currentRange.max;
    
    for (const y of hlineYs) {
      if (y < newMin) newMin = y;
      if (y > newMax) newMax = y;
    }
    
    // Only update if range changed (hlines are outside data range)
    if (newMin < currentRange.min || newMax > currentRange.max) {
      // Apply padding (10%)
      const range = newMax - newMin;
      const padding = range * 0.1;
      yAxis.visibleRange = new NumberRange(newMin - padding, newMax + padding);
      console.log(`[MultiPaneChart] Extended Y-axis for ${paneId} to include hlines: ${newMin - padding} to ${newMax + padding}`);
    }
  } catch (e) {
    console.warn(`[MultiPaneChart] zoomExtentsYWithHLines failed for ${paneId}:`, e);
    // Fallback to standard zoom
    try {
      surface.zoomExtentsY();
    } catch (e2) {
      // Ignore
    }
  }
}

/**
 * Update the "Waiting for Data" overlay for a pane based on assigned series data status
 * Shows spinner and count of pending series when some assigned series don't have data yet
 */
function updatePaneWaitingOverlay(
  refs: ChartRefs,
  layoutManager: PlotLayoutManager,
  paneId: string,
  plotLayout: ParsedLayout | null
): void {
  if (!plotLayout) return;
  
  // Get all series assigned to this pane from the layout
  const assignedSeries = layoutManager.getSeriesForPane(paneId);
  
  // If no series assigned, don't show waiting (pane might be empty by design)
  if (assignedSeries.length === 0) {
    const waitingOverlay = document.getElementById(`pane-${paneId}-waiting`);
    if (waitingOverlay) {
      waitingOverlay.style.display = 'none';
    }
    return;
  }
  
  // Check which assigned series have data
  let pendingCount = 0;
  let hasAnyData = false;
  const seriesStatus: string[] = [];

  for (const seriesId of assignedSeries) {
    const seriesEntry = refs.dataSeriesStore.get(seriesId);
    if (seriesEntry && seriesEntry.dataSeries) {
      // Check if series has data
      const count = seriesEntry.dataSeries.count();
      if (count > 0) {
        hasAnyData = true;
        seriesStatus.push(`${seriesId}: ${count} points`);
      } else {
        pendingCount++;
        seriesStatus.push(`${seriesId}: 0 points (waiting)`);
      }
    } else {
      // Series not created yet or not in store
      pendingCount++;
      seriesStatus.push(`${seriesId}: not created yet`);
    }
  }

  // Get the waiting overlay element (silently skip if not found)
  const waitingOverlay = document.getElementById(`pane-${paneId}-waiting`);
  if (!waitingOverlay) {
    return; // Overlay elements not rendered in current implementation
  }

  // Get the count element
  const countElement = document.getElementById(`pane-${paneId}-waiting-count`);

  if (pendingCount > 0) {
    // Show overlay with pending count
    waitingOverlay.style.display = 'flex';
    if (countElement) {
      countElement.textContent = `${pendingCount} ${pendingCount === 1 ? 'series' : 'series'} pending`;
    }
  } else {
    // All assigned series have data - hide overlay
    waitingOverlay.style.display = 'none';
    if (countElement) {
      countElement.textContent = '';
    }
  }
}

interface UIConfig {
  // New structure (matches requirements)
  data?: {
    registry?: {
      enabled?: boolean;
      maxRows?: number;
    };
    buffers: {
      pointsPerSeries: number; // Default preallocation size for ALL series (1,000,000)
      maxPointsTotal?: number;  // Global cap across all series (10,000,000)
    };
  };
  performance: {
    targetFPS: number;
    batchSize: number;
    downsampleRatio: number;
    maxAutoTicks: number;
    fifoEnabled?: boolean;
    fifoSweepSize?: number;
    updateIntervalMs?: number; // Min ms between RAF triggers (default: 16 = 60fps)
    // Resampling settings: "None" | "Auto" | "MinMax" | "MinMaxWithUnevenSpacing" | "Mid" | "Max" | "Min"
    resamplingMode?: string;
    // Resampling precision: higher = better quality, lower = better performance (1-10)
    resamplingPrecision?: number;
  };
  // UI drain settings for chunk processing
  uiDrain?: {
    maxBatchesPerFrame?: number; // Max chunks per animation frame (default: 16)
    maxMsPerFrame?: number; // Delay between chunks in ms (default: 0 = immediate)
  };
  chart: {
    separateXAxes: boolean;
    autoScroll: boolean;
    autoScrollThreshold: number;
    timezone?: string; // Timezone for DateTime axes (e.g., "UTC", "America/New_York")
  };
  dataCollection: {
    continueWhenPaused: boolean;
    backgroundBufferSize: number;
  };
  // Legacy support - map old structure to new structure
  dataBuffers?: {
    preallocatedPointsPerSeries?: number;
    tickSeriesCapacity?: number;
    ohlcSeriesCapacity?: number;
    indicatorSeriesCapacity?: number;
  };
}

interface MultiPaneChartProps {
  tickContainerId: string;
  ohlcContainerId: string;
  overviewContainerId?: string;
  onFpsUpdate?: (fps: number) => void;
  onDataClockUpdate?: (ms: number) => void;
  onReadyChange?: (ready: boolean) => void;
  onGpuUpdate?: (drawCalls: number) => void;
  visibleSeries?: Set<string>;
  uiConfig?: UIConfig;
  feedStage?: string; // 'history' | 'delta' | 'live' | 'idle'
  registry?: Array<{ id: string; lastMs: number }>; // Data registry for global data clock
  plotLayout?: ParsedLayout | null; // Plot layout for dynamic pane assignment
  zoomMode?: 'box' | 'x-only' | 'y-only'; // Zoom mode for chart interactions
  theme?: 'dark' | 'light'; // Theme for chart surfaces
  cursorEnabled?: boolean; // Enable/disable cursor modifier on charts
  legendsEnabled?: boolean; // Enable/disable plot titles/legends
  onTimeWindowChanged?: (window: { minutes: number; startTime: number; endTime: number } | null) => void; // Callback when time window changes (from minimap or setTimeWindow)
  onAutoScrollChange?: (enabled: boolean) => void; // Callback when auto-scroll state changes (for HUD sync)
}

// Unified DataSeries Store Entry
interface DataSeriesEntry {
  dataSeries: XyDataSeries | OhlcDataSeries;
  renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
  chartTarget: 'tick' | 'ohlc'; // Legacy: Which chart surface this series belongs to (for backward compatibility)
  paneId?: string; // New: Which pane this series belongs to (for dynamic layouts)
  seriesType: 'tick' | 'ohlc-bar' | 'tick-indicator' | 'bar-indicator' | 'strategy-marker' | 'strategy-signal' | 'strategy-pnl' | 'other';
  renderableSeriesType?: 'FastLineRenderableSeries' | 'FastCandlestickRenderableSeries' | 'FastMountainRenderableSeries'; // Type from layout JSON
}

interface PaneSurface {
  surface: SciChartSurface;
  wasm: TSciChart;
  xAxis: DateTimeNumericAxis;
  yAxis: NumericAxis;
  containerId: string;
  paneId: string;
  hasData?: boolean; // Optional: tracks if pane has received data
  waitingForData?: boolean; // Optional: tracks if pane is waiting for data
}

interface ChartRefs {
  tickSurface: SciChartSurface | null; // Legacy - for backward compatibility
  ohlcSurface: SciChartSurface | null; // Legacy - for backward compatibility
  tickWasm: TSciChart | null; // Legacy
  ohlcWasm: TSciChart | null; // Legacy
  // Dynamic pane registry: paneId → PaneSurface
  paneSurfaces: Map<string, PaneSurface>;
  // Unified DataSeries Store: series_id → DataSeriesEntry
  // This replaces separate Maps and allows dynamic discovery
  dataSeriesStore: Map<string, DataSeriesEntry>;
  verticalGroup: SciChartVerticalGroup | null;
  overview: SciChartOverview | null;
  // Shared WASM context for all panes (created once)
  sharedWasm: TSciChart | null;
  // Strategy marker scatter series per pane (5 series per pane for each marker type)
  markerScatterSeries: Map<string, Map<MarkerSeriesType, MarkerScatterGroup>>;
  // Persistent buffer of raw marker samples for replay after layout reload
  // Strategy markers don't go into SharedDataSeriesPool, so we must keep them here
  markerSampleHistory: Array<{ series_id: string; t_ms: number; t_ns?: number; payload: Record<string, unknown> }>;
  
  updateFpsCallback?: () => void; // FPS update callback for subscribing to dynamic pane surfaces
  
  // Track which series have received data (series_id -> boolean)
  seriesHasData: Map<string, boolean>;
  
  // Track waiting annotations per pane (paneId -> TextAnnotation)
  waitingAnnotations: Map<string, TextAnnotation>;
}

/**
 * Convert t_ms + optional t_ns to seconds with nanosecond precision.
 * t_ns is the nanosecond remainder within the millisecond (0–999_999).
 */
function toSecondsPrecise(t_ms: number, t_ns?: number): number {
  return t_ms / 1000 + (t_ns ? t_ns / 1_000_000_000 : 0);
}

/**
 * Main chart hook for multi-pane SciChart visualization.
 * 
 * NOTE: This is a very large hook (~8500 lines). If you see a React error
 * "Should have a queue" after editing this file, do a HARD PAGE REFRESH (Ctrl+Shift+R)
 * to clear the corrupted HMR state. This error occurs during Vite HMR when React's
 * fiber structure becomes desynchronized in large hooks.
 */
export function useMultiPaneChart({
  tickContainerId,
  ohlcContainerId,
  overviewContainerId,
  onFpsUpdate,
  onDataClockUpdate,
  onReadyChange,
  onGpuUpdate,
  visibleSeries,
  uiConfig,
  feedStage = 'idle',
  registry = [],
  plotLayout = null,
  zoomMode = 'box',
  theme = 'dark',
  cursorEnabled = false,
  legendsEnabled = false,
  onTimeWindowChanged,
  onAutoScrollChange,
}: MultiPaneChartProps) {
  // Default UI config if not provided
  const defaultUIConfig: UIConfig = {
    data: {
      buffers: {
        pointsPerSeries: 2_000_000, // SciChart handles 10M+ points efficiently
        maxPointsTotal: 10_000_000, // Global cap across all series (10M points)
      },
    },
    performance: {
      targetFPS: 60,
      batchSize: 5000, // Large batches for SciChart's WebGL efficiency
      downsampleRatio: 1, // CRITICAL: No downsampling - plot all data points
      maxAutoTicks: 10,
      fifoEnabled: true,
      fifoSweepSize: 100000, // Larger FIFO sweep for high-throughput data
      resamplingMode: 'Auto', // None, Auto, MinMax, MinMaxWithUnevenSpacing, Mid, Max, Min
      resamplingPrecision: 1, // Quality vs performance (1-10, higher = better quality)
    },
    chart: {
      separateXAxes: false,
      autoScroll: true,
      autoScrollThreshold: 200,
      timezone: 'UTC',
    },
    dataCollection: {
      continueWhenPaused: true,
      backgroundBufferSize: 10_000_000,
    },
  };
  
  // Merge user config with defaults, supporting both old and new structure
  const config: UIConfig = uiConfig ? {
    ...defaultUIConfig,
    ...uiConfig,
    // Support legacy dataBuffers structure
    data: {
      ...defaultUIConfig.data,
      ...uiConfig.data,
      buffers: {
        pointsPerSeries: uiConfig.data?.buffers?.pointsPerSeries 
          ?? uiConfig.dataBuffers?.preallocatedPointsPerSeries 
          ?? defaultUIConfig.data!.buffers.pointsPerSeries,
        maxPointsTotal: uiConfig.data?.buffers?.maxPointsTotal 
          ?? defaultUIConfig.data!.buffers.maxPointsTotal,
      },
    },
  } : defaultUIConfig;
  
  // ============================================================================
  // CRITICAL: All useState and key useRef declarations MUST be at the top
  // before any code that references them. This prevents HMR "Should have a queue"
  // errors caused by hook order inconsistency.
  // ============================================================================
  
  // Core chart refs - MUST be declared before any functions that use them
  const chartRefs = useRef<ChartRefs>({
    tickSurface: null, // Legacy - for backward compatibility
    ohlcSurface: null, // Legacy - for backward compatibility
    tickWasm: null, // Legacy
    ohlcWasm: null, // Legacy
    paneSurfaces: new Map<string, PaneSurface>(), // Dynamic pane registry
    // Unified DataSeries Store: series_id → DataSeriesEntry
    // All series (tick, OHLC, indicators) are stored here
    dataSeriesStore: new Map<string, DataSeriesEntry>(),
    verticalGroup: null,
    overview: null,
    sharedWasm: null, // Shared WASM context for all dynamic panes
    markerScatterSeries: new Map<string, Map<MarkerSeriesType, MarkerScatterGroup>>(),
    markerSampleHistory: [],
    seriesHasData: new Map<string, boolean>(),
    waitingAnnotations: new Map<string, TextAnnotation>(),
  });

  // Core state - MUST be declared before functions reference them
  const [isReady, setIsReady] = useState(false);
  const [parentSurfaceReady, setParentSurfaceReady] = useState(false);
  const [overviewNeedsRefresh, setOverviewNeedsRefresh] = useState(0); // Counter to trigger overview refresh
  const [panesReadyCount, setPanesReadyCount] = useState(0); // Track when panes are created (triggers preallocation)
  const overviewNeedsRefreshSetterRef = useRef<((value: number) => void) | null>(null);
  
  // Store the setter in a ref so it can be accessed from processBatchedSamples
  useEffect(() => {
    overviewNeedsRefreshSetterRef.current = setOverviewNeedsRefresh;
  }, []);

  // Cleanup any pending minimap selectedArea updates on unmount
  useEffect(() => {
    return () => {
      if (minimapSelectedAreaUpdateTimeoutRef.current) {
        clearTimeout(minimapSelectedAreaUpdateTimeoutRef.current);
        minimapSelectedAreaUpdateTimeoutRef.current = null;
      }
    };
  }, []);
  
  const fpsCounter = useRef({ frameCount: 0, lastTime: performance.now() });

  // Layout manager instance (created once)
  const layoutManagerRef = useRef<PlotLayoutManager | null>(null);
  if (!layoutManagerRef.current) {
    layoutManagerRef.current = new PlotLayoutManager();
  }
  const layoutManager = layoutManagerRef.current;

  // Dynamic pane manager instance (will be initialized after chartTheme is defined)
  const paneManagerRef = useRef<DynamicPaneManager | null>(null);
  
  // Track which panes are being created to avoid duplicates
  const creatingPanesRef = useRef<Set<string>>(new Set());
  
  // Track which series have been preallocated to prevent re-running
  const preallocatedSeriesRef = useRef<Set<string>>(new Set());
  
  // Track which series we've already warned about (to avoid spam)
  const warnedSeriesRef = useRef<Set<string>>(new Set());

  // Track last appended X per series to enforce sortedness safely.
  // This helps avoid undefined behaviour when DataSeries is created with dataIsSortedInX=true.
  const lastXBySeriesRef = useRef<Map<string, number>>(new Map());

  // Throttle warnings for out-of-order/non-finite data per series
  const lastBatchWarnTimeRef = useRef<Map<string, number>>(new Map());

  // Cancelable timer for minimap selectedArea updates (prevents stale async updates
  // from touching a deleted surface/axis during layout/theme transitions)
  const minimapSelectedAreaUpdateTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // CRITICAL: Preserve DataSeries data during layout changes (for static data feeds)
  // This ensures data isn't lost when layout changes and new series are created
  const preservedDataSeriesRef = useRef<Map<string, { dataSeries: XyDataSeries | OhlcDataSeries; wasm: TSciChart }>>(new Map());
  
  // Ref for plotLayout to avoid stale closure in callbacks
  const plotLayoutRef = useRef(plotLayout);
  useEffect(() => {
    plotLayoutRef.current = plotLayout;
  }, [plotLayout]);
  useEffect(() => {
    if (plotLayout) {
      // Layout is already parsed, just update the manager's internal state
      layoutManagerRef.current?.loadLayout(plotLayout.layout);
      
      // Initialize series data tracking for all series in the layout
      // Set all series to false initially (no data received yet)
      const refs = chartRefs.current;
      for (const seriesAssignment of plotLayout.layout.series) {
        // Only initialize if not already set (preserve existing data state)
        if (!refs.seriesHasData.has(seriesAssignment.series_id)) {
          refs.seriesHasData.set(seriesAssignment.series_id, false);
        }
      }
      
      // Clear waiting annotations from previous layout
      for (const [paneId, annotation] of refs.waitingAnnotations) {
        try {
          const paneSurface = refs.paneSurfaces.get(paneId);
          if (paneSurface) {
            paneSurface.surface.annotations.remove(annotation);
          }
          annotation.delete();
        } catch (e) {
          // Ignore errors
        }
      }
      refs.waitingAnnotations.clear();
      
      // Initialize session mode based on layout's default X-axis range
      // NOTE: We only set refs here. The actual range application happens in the
      // feedStage transition effect (history→live) or in the auto-scroll loop.
      // Do NOT call zoomExtents here because surfaces may not have data yet.
      const defaultRange = plotLayout.xAxisDefaultRange;
      if (defaultRange?.mode === 'session') {
        // Enable session mode for "entire session" default
        sessionModeRef.current = true;
        selectedWindowMinutesRef.current = null;
        minimapStickyRef.current = true;
        timeWindowSelectedRef.current = true;
        isLiveRef.current = true;
        userInteractedRef.current = false;
        yAxisManuallyStretchedRef.current = false;
        console.log('[MultiPaneChart] Initialized session mode from layout JSON');
      } else if (defaultRange?.mode === 'lastMinutes' && defaultRange.value) {
        // Set specific time window from layout
        sessionModeRef.current = false;
        selectedWindowMinutesRef.current = defaultRange.value;
        minimapStickyRef.current = true;
        timeWindowSelectedRef.current = true;
        isLiveRef.current = true;
        userInteractedRef.current = false;
        yAxisManuallyStretchedRef.current = false;
        lastYAxisUpdateRef.current = 0;
        console.log(`[MultiPaneChart] Initialized ${defaultRange.value} minute window from layout JSON`);
      }
    }
  }, [plotLayout]);

  // Helper to get preallocation capacity for any series
  const getSeriesCapacity = (): number => {
    return config.data?.buffers.pointsPerSeries ?? 1_000_000;
  };
  
  // Helper to convert resampling mode string to SciChart enum
  const getResamplingMode = (): EResamplingMode => {
    const modeStr = config.performance.resamplingMode ?? 'Auto';
    switch (modeStr) {
      case 'None': return EResamplingMode.None;
      case 'MinMax': return EResamplingMode.MinMax;
      case 'MinMaxWithUnevenSpacing': return EResamplingMode.MinMaxWithUnevenSpacing;
      case 'Mid': return EResamplingMode.Mid;
      case 'Max': return EResamplingMode.Max;
      case 'Min': return EResamplingMode.Min;
      case 'Auto':
      default: return EResamplingMode.Auto;
    }
  };
  
  // Helper to get resampling precision (affects quality vs performance)
  const getResamplingPrecision = (): number => {
    return config.performance.resamplingPrecision ?? 1;
  };


  // Calculate default X-axis range from layout config
  // IMPORTANT: All inputs and outputs are in SECONDS (matching SciChart DateTimeNumericAxis)
  const calculateDefaultXAxisRange = (
    defaultRange: PlotLayout['xAxis']['defaultRange'],
    latestTime: number, // in SECONDS
    dataMin?: number,   // in SECONDS
    dataMax?: number    // in SECONDS
  ): NumberRange | null => {
    if (!defaultRange) return null;

    const now = latestTime > 0 ? latestTime : Date.now() / 1000; // Convert ms to seconds
    let rangeMin: number;
    let rangeMax: number;

    switch (defaultRange.mode) {
      case 'lastMinutes':
        if (defaultRange.value && defaultRange.value > 0) {
          const minutes = defaultRange.value;
          rangeMin = now - (minutes * 60); // seconds
          rangeMax = now + 10; // 10 seconds padding
        } else {
          return null;
        }
        break;

      case 'lastHours':
        if (defaultRange.value && defaultRange.value > 0) {
          const hours = defaultRange.value;
          rangeMin = now - (hours * 60 * 60); // seconds
          rangeMax = now + 10; // 10 seconds padding
        } else {
          return null;
        }
        break;

      case 'entireSession':
        // Show all data in the buffer (one-time calculation)
        if (dataMin !== undefined && dataMax !== undefined && dataMin < dataMax) {
          const padding = (dataMax - dataMin) * 0.05; // 5% padding
          rangeMin = dataMin - padding;
          rangeMax = dataMax + padding;
        } else {
          // Fallback: use a large window if data range not available
          const sessionWindow = 8 * 60 * 60; // 8 hours in seconds
          rangeMin = now - sessionWindow;
          rangeMax = now + 10;
        }
        break;

      case 'session':
        // ALWAYS show all data from N=1 to latest point in buffer (dynamic in live mode)
        if (dataMin !== undefined && dataMax !== undefined && dataMin < dataMax) {
          const padding = (dataMax - dataMin) * 0.02; // 2% padding for tighter fit
          rangeMin = dataMin - padding;
          rangeMax = dataMax + padding;
        } else {
          // No data yet, use reasonable defaults
          rangeMin = now - 60; // 1 minute back in seconds
          rangeMax = now + 10;
        }
        break;

      case 'custom':
        if (defaultRange.customRange && defaultRange.customRange.length === 2) {
          rangeMin = defaultRange.customRange[0];
          rangeMax = defaultRange.customRange[1];
        } else {
          return null;
        }
        break;

      default:
        return null;
    }

    return new NumberRange(rangeMin, rangeMax);
  };
  
  // Helper to find first series of a given type from unified store
  const findSeriesByType = (type: 'tick' | 'ohlc-bar'): DataSeriesEntry | null => {
    for (const [seriesId, entry] of chartRefs.current.dataSeriesStore) {
      if (entry.seriesType === type) {
        return entry;
      }
    }
    return null;
  };

  /**
   * Get the renderable series type from layout, or infer from series type
   * Strategy series types (strategy_markers, strategy_pnl, strategy_signals) are handled separately
   */
  const getRenderableSeriesType = (seriesId: string): 'FastLineRenderableSeries' | 'FastCandlestickRenderableSeries' | 'FastMountainRenderableSeries' => {
    // Check layout for explicit type
    if (plotLayout) {
      const seriesAssignment = plotLayout.layout.series.find(s => s.series_id === seriesId);
      if (seriesAssignment) {
        // Handle strategy series types - they get rendered as specific series types
        if (seriesAssignment.type === 'strategy_pnl') {
          return 'FastMountainRenderableSeries'; // PnL uses mountain series by default
        }
        if (seriesAssignment.type === 'strategy_markers' || seriesAssignment.type === 'strategy_signals') {
          return 'FastLineRenderableSeries'; // Markers/signals use scatter series internally (handled separately)
        }
        // Return base series type directly
        return seriesAssignment.type as 'FastLineRenderableSeries' | 'FastCandlestickRenderableSeries' | 'FastMountainRenderableSeries';
      }
    }
    
    // Fallback: infer from series type
    const seriesInfo = parseSeriesType(seriesId);
    if (seriesInfo.type === 'ohlc-bar') {
      return 'FastCandlestickRenderableSeries';
    }
    
    // Default to line series (can be overridden by layout)
    return 'FastLineRenderableSeries';
  };

  /**
   * Get the pane ID for a series based on layout or fallback to namespace-based routing
   */
  // Helper function to calculate Y-range from DataSeries manually
  // getYRange() doesn't exist on DataSeries, so we calculate it by iterating through data
  const calculateYRange = (
    dataSeries: XyDataSeries | OhlcDataSeries,
    xMin?: number,
    xMax?: number
  ): { min: number; max: number } | null => {
    try {
      if (dataSeries.count() === 0) return null;
      
      const xValues = dataSeries.getNativeXValues();
      const yValues = dataSeries.getNativeYValues();
      
      if (!xValues || !yValues || xValues.size() === 0) return null;
      
      let yMin = Infinity;
      let yMax = -Infinity;
      let foundData = false;
      
      for (let i = 0; i < xValues.size(); i++) {
        const x = xValues.get(i);
        const y = yValues.get(i);
        
        // If X-range filter is provided, only include data within that range
        if (xMin !== undefined && xMax !== undefined) {
          if (x < xMin || x > xMax) continue;
        }
        
        if (isFinite(y)) {
          yMin = Math.min(yMin, y);
          yMax = Math.max(yMax, y);
          foundData = true;
        }
      }
      
      if (foundData && yMax > yMin) {
        return { min: yMin, max: yMax };
      }
      
      return null;
    } catch (e) {
      return null;
    }
  };
  // Helper: Check if a series is defined in the current layout
  // Returns true if series is in layout or no layout is loaded (legacy mode)
  const isSeriesInLayout = (seriesId: string): boolean => {
    if (!plotLayout || !layoutManager) {
      // No layout loaded - allow all series (legacy mode)
      return true;
    }
    // Check if series is explicitly defined in layout
    return layoutManager.getPaneForSeries(seriesId) !== null;
  };

  // Helper: Update waiting annotations for all panes based on data availability
  const updateWaitingAnnotations = useCallback(() => {
    const refs = chartRefs.current;
    
    if (!plotLayout || !layoutManager) {
      return; // No layout, no waiting annotations needed
    }

    // Don't update annotations if surfaces aren't ready yet
    if (refs.paneSurfaces.size === 0) {
      return; // No panes created yet
    }

    // Check each pane
    for (const paneConfig of plotLayout.layout.panes) {
      const paneId = paneConfig.id;
      const paneSurface = refs.paneSurfaces.get(paneId);
      
      if (!paneSurface) {
        continue; // Pane not created yet
      }

      // Get all series assigned to this pane
      const seriesForPane = layoutManager.getSeriesForPane(paneId);
      
      if (seriesForPane.length === 0) {
        // No series assigned to this pane, remove annotation if exists
        const existingAnnotation = refs.waitingAnnotations.get(paneId);
        if (existingAnnotation) {
          try {
            paneSurface.surface.annotations.remove(existingAnnotation);
            existingAnnotation.delete();
          } catch (e) {
            // Ignore errors
          }
          refs.waitingAnnotations.delete(paneId);
        }
        continue;
      }

      // Check if all CHARTABLE series for this pane have received data.
      // Skip series with type: strategy_markers or strategy_signals since they are rendered
      // as annotations, not as chart lines. They should NOT block the "Waiting for Data..." status.
      const allSeriesHaveData = seriesForPane.every(seriesId => {
        // Check if this series has chartTarget: 'none' (strategy markers/signals)
        // These are rendered as annotations and should not block waiting status
        const seriesAssignment = plotLayout?.layout.series.find(s => s.series_id === seriesId);
        if (seriesAssignment) {
          // Series with these types are rendered as annotations, not chart lines
          if (seriesAssignment.type === 'strategy_markers' || seriesAssignment.type === 'strategy_signals') {
            return true; // Skip this check - consider it "has data" for waiting purposes
          }
        }
        return refs.seriesHasData.get(seriesId) === true;
      });

      const existingAnnotation = refs.waitingAnnotations.get(paneId);

      if (!allSeriesHaveData) {
        // Some series are missing data - show waiting annotation
        if (!existingAnnotation) {
          // Create new annotation
          try {
            // Ensure WASM context is available (needed for annotation operations)
            const wasm = paneSurface.wasm || refs.sharedWasm;
            if (!wasm || !paneSurface.surface || !paneSurface.xAxis || !paneSurface.yAxis) {
              // Not ready yet, skip annotation creation
              return;
            }

            // Validate that the surface is not deleted
            if ((paneSurface.surface as any).isDeleted) {
              return;
            }

            // Check if axes have valid ranges - if not, set temporary default ranges
            // This prevents "Aborted()" errors when using relative coordinates with empty axes
            let xRange = paneSurface.xAxis.visibleRange;
            let yRange = paneSurface.yAxis.visibleRange;
            
            const now = Date.now() / 1000; // Current time in seconds
            
            // Set default X range if empty (last hour)
            if (!xRange || !isFinite(xRange.min) || !isFinite(xRange.max) || xRange.min === xRange.max) {
              try {
                paneSurface.xAxis.visibleRange = new NumberRange(now - 3600, now);
                xRange = paneSurface.xAxis.visibleRange;
              } catch (e) {
                console.warn(`[MultiPaneChart] Error setting default X range for pane ${paneId}:`, e);
                return; // Can't create annotation without valid X range
              }
            }
            
            // Set default Y range if empty (0 to 100)
            if (!yRange || !isFinite(yRange.min) || !isFinite(yRange.max) || yRange.min === yRange.max) {
              try {
                paneSurface.yAxis.visibleRange = new NumberRange(0, 100);
                yRange = paneSurface.yAxis.visibleRange;
              } catch (e) {
                console.warn(`[MultiPaneChart] Error setting default Y range for pane ${paneId}:`, e);
                return; // Can't create annotation without valid Y range
              }
            }

            // Use relative coordinates now that we have valid ranges
            const annotation = new TextAnnotation({
              x1: 0.5, // Center horizontally (relative to axis range)
              y1: 0.5, // Center vertically (relative to axis range)
              xAxisId: paneSurface.xAxis.id,
              yAxisId: paneSurface.yAxis.id,
              xCoordinateMode: ECoordinateMode.Relative,
              yCoordinateMode: ECoordinateMode.Relative,
              horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
              verticalAnchorPoint: EVerticalAnchorPoint.Center,
              text: "Waiting for Data...",
              fontSize: 16,
              fontWeight: "Bold",
              opacity: 0.7,
              textColor: "#9fb2c9", // Match theme text color
            });

            paneSurface.surface.annotations.add(annotation);
            refs.waitingAnnotations.set(paneId, annotation);
          } catch (e) {
            // Silently handle errors - annotation creation might fail if surface isn't ready
            console.warn(`[MultiPaneChart] Error creating waiting annotation for pane ${paneId}:`, e);
          }
        }
      } else {
        // All series have data - remove annotation if exists
        if (existingAnnotation) {
          try {
            paneSurface.surface.annotations.remove(existingAnnotation);
            existingAnnotation.delete();
          } catch (e) {
            // Ignore errors
          }
          refs.waitingAnnotations.delete(paneId);
        }
      }
    }
  }, [plotLayout, layoutManager]);

  const getPaneForSeries = (seriesId: string): { paneId: string | null; surface: SciChartSurface | null; wasm: TSciChart | null } => {
    const refs = chartRefs.current;
    
    // If layout is provided, use layout manager to get the correct pane
    if (plotLayout && layoutManager) {
      const paneId = layoutManager.getPaneForSeries(seriesId);
      if (paneId) {
        // Get the surface from dynamic panes
        const paneSurface = refs.paneSurfaces.get(paneId);
        if (paneSurface) {
          return { paneId, surface: paneSurface.surface, wasm: paneSurface.wasm };
        }
        
        // Pane defined in layout but surface not created yet
        // Return paneId so caller knows this series SHOULD be plotted, just not ready yet
        // NO FALLBACK: strict layout enforcement - never route to a different pane
        return { paneId, surface: null, wasm: null };
      }
    }
    
    // STRICT LAYOUT ENFORCEMENT: If series is not in layout, do NOT plot it
    // No fallback auto-routing based on series_id patterns
    // Layout JSON is the single source of truth
    return { paneId: null, surface: null, wasm: null };
  };
  
  // Helper to create a series on-demand when data arrives before preallocation
  // This is a fallback for timing issues - primary creation should be via preallocation
  const ensureSeriesExists = (seriesId: string): DataSeriesEntry | null => {
    const refs = chartRefs.current;
    
    // Check if already exists
    if (refs.dataSeriesStore.has(seriesId)) {
      const existing = refs.dataSeriesStore.get(seriesId)!;
      console.log(`[ensureSeriesExists] ✅ Series ${seriesId} already exists in dataSeriesStore (${existing.dataSeries?.count() || 0} points)`);
      return existing;
    }
    
    console.log(`[ensureSeriesExists] 🔍 Checking conditions for creating ${seriesId}...`);
    
    // Only create on-demand if:
    // 1. Panes are ready
    // 2. Series is in layout (don't create series not meant to be plotted)
    // 3. We have valid WASM context
    if (!plotLayout) {
      console.log(`[ensureSeriesExists] ❌ No plotLayout - cannot create ${seriesId}`);
      return null;
    }
    if (refs.paneSurfaces.size === 0) {
      console.log(`[ensureSeriesExists] ❌ No pane surfaces - cannot create ${seriesId}`);
      return null;
    }
    if (!isReady) {
      console.log(`[ensureSeriesExists] ❌ Chart not ready (isReady=false) - cannot create ${seriesId}`);
      return null;
    }
    
    // Check if series is in layout
    if (!isSeriesInLayout(seriesId)) {
      console.log(`[ensureSeriesExists] ⚠️ Series ${seriesId} not in layout - skipping`);
      return null;
    }
    
    // Can't create if charts aren't ready
    // CRITICAL: For dynamic panes, we don't need legacy surfaces - check for panes instead
    const hasLegacySurfaces = refs.tickSurface && refs.ohlcSurface && refs.tickWasm && refs.ohlcWasm;
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    
    if (!hasLegacySurfaces && !hasDynamicPanes) {
      console.log(`[ensureSeriesExists] ❌ No surfaces available (legacy: ${hasLegacySurfaces}, dynamic: ${hasDynamicPanes})`);
      return null;
    }
    
    // CRITICAL: Ensure we have a valid WASM context before creating DataSeries
    // This prevents WASM abort errors
    const { paneId, surface, wasm } = getPaneForSeries(seriesId);
    if (!wasm || !surface || !paneId) {
      console.log(`[ensureSeriesExists] ❌ Invalid pane/surface/WASM for ${seriesId} (paneId: ${paneId}, surface: ${!!surface}, wasm: ${!!wasm})`);
      return null;
    }
    
    // CRITICAL: Ensure sharedWasm is available for DataSeries creation
    // DataSeries must use sharedWasm to prevent sharing issues
    if (!refs.sharedWasm && !wasm) {
      console.log(`[ensureSeriesExists] ❌ No WASM context for ${seriesId}`);
      return null;
    }
    
    const seriesInfo = parseSeriesType(seriesId);
    
    // Only create series that should be plotted on charts
    if (seriesInfo.chartTarget === 'none') {
      console.log(`[ensureSeriesExists] ⚠️ Series ${seriesId} has chartTarget=none - skipping`);
      return null;
    }
    
    console.log(`[ensureSeriesExists] ✅ All conditions met for ${seriesId}, creating series...`);
    console.log(`[ensureSeriesExists] 📋 Series info: paneId=${paneId}, type=${seriesInfo.type}, chartTarget=${seriesInfo.chartTarget}`);
    
    try {
      // ON-DEMAND SERIES CREATION (fallback path):
      // Avoid huge upfront FIFO/capacity allocations because those can trigger SciChart WASM "Aborted()"
      // and freeze the UI when many unseen series appear.
      // Preallocation (the normal path) still uses the configured FIFO buffers.
      const onDemandInitialCapacity = 10_000;
      
      // paneId, surface, wasm already validated above
      
      // Get renderable series type from layout or infer from series type
      const renderableSeriesType = getRenderableSeriesType(seriesId);
      
      // CRITICAL: Use sharedWasm for DataSeries to prevent sharing issues
      // But ensure WASM is actually valid before using it
      const dataSeriesWasm = refs.sharedWasm || wasm;
      
      // CRITICAL: Validate WASM context before creating DataSeries
      // WASM abort errors occur when WASM context is invalid or not properly initialized
      if (!dataSeriesWasm || !wasm) {
        // Invalid WASM context - silently skip
        return null;
      }
      
      // CRITICAL: First check sharedDataSeriesPool - persists across layout changes
      const pooledEntry = sharedDataSeriesPool.get(seriesId);
      
      // Create DataSeries with preallocated circular buffer
      let dataSeries: XyDataSeries | OhlcDataSeries;
      let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
      
      // Reuse dataSeries from pool if it exists (preserves data across layout changes)
      if (pooledEntry && pooledEntry.dataSeries) {
        dataSeries = pooledEntry.dataSeries;
        console.log(`[MultiPaneChart] ♻️ ensureSeriesExists: Reusing from pool: ${seriesId} (${dataSeries.count()} points)`);
      } else {
        // Create new DataSeries via the pool (ensures consistency)
        const seriesPoolType = (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') ? 'ohlc' : 'xy';
        const newPooledEntry = sharedDataSeriesPool.getOrCreate(seriesId, seriesPoolType);
        if (!newPooledEntry) {
          console.warn(`[MultiPaneChart] ❌ ensureSeriesExists: Failed to create dataSeries via pool: ${seriesId}`);
          return null;
        }
        dataSeries = newPooledEntry.dataSeries;
        console.log(`[MultiPaneChart] 🆕 ensureSeriesExists: Created dataSeries via pool: ${seriesId}`);
      }
      
      // Create renderable series (always new - only renderableSeries are recreated on layout change)
      if (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') {
        renderableSeries = new FastCandlestickRenderableSeries(wasm, {
          dataSeries: dataSeries as OhlcDataSeries,
          strokeUp: '#26a69a',
          brushUp: '#26a69a88',
          strokeDown: '#ef5350',
          brushDown: '#ef535088',
          strokeThickness: 1,
          resamplingMode: getResamplingMode(),
          resamplingPrecision: getResamplingPrecision(),
        });
      } else {
        // Get series assignment from layout for styling
        const seriesAssignment = plotLayout?.layout.series.find(s => s.series_id === seriesId);
        
        // Determine stroke color based on type or layout style
        let stroke = seriesAssignment?.style?.stroke;
        if (!stroke) {
          stroke = '#50C7E0'; // Default tick color
          if (seriesInfo.isIndicator) {
            stroke = '#F48420'; // Orange for indicators
          } else if (seriesInfo.type === 'strategy-pnl') {
            stroke = '#4CAF50'; // Green for PnL
          } else if (seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') {
            stroke = '#FF9800'; // Orange for markers/signals
          }
        }
        
        const strokeThickness = seriesAssignment?.style?.strokeThickness ?? 1;
        const fill = seriesAssignment?.style?.fill ?? (stroke + '44');
        let pointMarker: EllipsePointMarker | undefined;
        const pmConfig = seriesAssignment?.style?.pointMarker;
        if (pmConfig) {
          const pmEnabled = typeof pmConfig === 'boolean' ? pmConfig : (pmConfig.enabled !== false);
          if (pmEnabled) {
            const pmSize = (typeof pmConfig === 'object' && pmConfig.size) ? pmConfig.size : 7;
            const pmFill = (typeof pmConfig === 'object' && pmConfig.color) ? pmConfig.color : stroke;
            const pmStroke = (typeof pmConfig === 'object' && pmConfig.strokeColor) ? pmConfig.strokeColor : stroke;
            pointMarker = new EllipsePointMarker(wasm, {
              width: pmSize,
              height: pmSize,
              fill: pmFill,
              stroke: pmStroke,
              strokeThickness: 1,
            });
          }
        }
        
        if (renderableSeriesType === 'FastMountainRenderableSeries') {
          renderableSeries = new FastMountainRenderableSeries(wasm, {
            dataSeries: dataSeries as XyDataSeries,
            stroke: stroke,
            fill: fill,
            strokeThickness: strokeThickness,
            pointMarker: pointMarker,
            resamplingMode: getResamplingMode(),
            resamplingPrecision: getResamplingPrecision(),
          });
        } else {
          renderableSeries = new FastLineRenderableSeries(wasm, {
            dataSeries: dataSeries as XyDataSeries,
            stroke: stroke,
            strokeThickness: strokeThickness,
            pointMarker: pointMarker,
            resamplingMode: getResamplingMode(),
            resamplingPrecision: getResamplingPrecision(),
          });
        }
      }
      
      // Add to store
      // Note: chartTarget is 'tick' | 'ohlc' but seriesInfo.chartTarget can be 'none'
      // We only create entries for series that should be plotted (chartTarget !== 'none'), so safe to cast
      // Since we already checked chartTarget !== 'none' above, we know it's 'tick' or 'ohlc'
      const entry: DataSeriesEntry = {
        dataSeries,
        renderableSeries,
        chartTarget: seriesInfo.chartTarget as 'tick' | 'ohlc', // Safe: we only reach here if chartTarget !== 'none'
        paneId: paneId, // New: pane-based routing
        seriesType: seriesInfo.type, // Now allows 'other' in type definition
        renderableSeriesType: renderableSeriesType, // Store the type from layout
      };
      refs.dataSeriesStore.set(seriesId, entry);
      
      console.log(`[ensureSeriesExists] ✅ Created entry for ${seriesId}:`, {
        paneId,
        seriesType: seriesInfo.type,
        renderableSeriesType,
        dataPoints: dataSeries.count(),
        isVisible: renderableSeries.isVisible,
      });
      
      // Add to appropriate chart surface
      surface.renderableSeries.add(renderableSeries);
      console.log(`[ensureSeriesExists] ✅ Added renderableSeries to surface for pane ${paneId}`);
      
      // Set initial visibility based on visibleSeries prop
      // CRITICAL: If series is in layout, make it visible by default (even if not in visibleSeries yet)
      const isInLayout = plotLayout?.layout.series.some(s => s.series_id === seriesId);
      if (visibleSeries) {
        renderableSeries.isVisible = visibleSeries.has(seriesId) || isInLayout;
      } else {
        // If no visibleSeries set, default to visible if in layout
        renderableSeries.isVisible = isInLayout !== false;
      }
      
    
      // Invalidate surfaces to ensure new series are rendered
      // CRITICAL: Invalidate the correct surface (legacy or dynamic pane)
      if (paneId && refs.paneSurfaces.has(paneId)) {
        // Dynamic pane - invalidate the specific pane
        const paneSurface = refs.paneSurfaces.get(paneId);
        if (paneSurface) {
          paneSurface.surface.invalidateElement();
          console.log(`[ensureSeriesExists] 🔄 Invalidated pane surface: ${paneId}`);
        }
      } else {
        // Legacy surface - invalidate tick or ohlc
        if (seriesInfo.chartTarget === 'tick' && refs.tickSurface) {
          refs.tickSurface.invalidateElement();
        } else if (seriesInfo.chartTarget === 'ohlc' && refs.ohlcSurface) {
          refs.ohlcSurface.invalidateElement();
        }
      }
      
      console.log(`[ensureSeriesExists] 🎉 Successfully created series ${seriesId} with ${dataSeries.count()} points`);
      return entry;
    } catch (e) {
      console.error(`[ensureSeriesExists] ❌ Failed to create series ${seriesId}:`, e);
      return null;
    }
  };
  // NOTE: chartRefs, useState hooks (isReady, parentSurfaceReady, etc.), and fpsCounter
  // are now declared at the top of the hook to prevent HMR "Should have a queue" errors
  
  // FPS tracking using requestAnimationFrame to count actual browser frames
  // This is more accurate than counting surface renders (which can fire multiple times per frame)
  useEffect(() => {
    let rafId: number | null = null;
    let lastFrameTime = performance.now();
    
    const measureFPS = () => {
      const now = performance.now();
      fpsCounter.current.frameCount++;
      const elapsed = now - fpsCounter.current.lastTime;
      
      if (elapsed >= 1000) {
        const fps = Math.round((fpsCounter.current.frameCount * 1000) / elapsed);
        fpsCounter.current.frameCount = 0;
        fpsCounter.current.lastTime = now;
        onFpsUpdate?.(fps);
        
        // Get GPU metrics from SciChart's WebGL rendering context
        // Estimate draw calls from renderableSeries count (each series = multiple draw calls)
        let totalSeriesCount = 0;
        if (chartRefs.current.tickSurface) {
          totalSeriesCount += chartRefs.current.tickSurface.renderableSeries.size();
        }
        if (chartRefs.current.ohlcSurface) {
          totalSeriesCount += chartRefs.current.ohlcSurface.renderableSeries.size();
        }
        // Also count series from dynamic panes
        chartRefs.current.paneSurfaces.forEach((paneSurface) => {
          totalSeriesCount += paneSurface.surface.renderableSeries.size();
        });
        const estimatedDrawCalls = totalSeriesCount * 2; // ~2 calls per series
        onGpuUpdate?.(estimatedDrawCalls);
      }
      
      // Continue measuring
      rafId = requestAnimationFrame(measureFPS);
    };
    
    // Start FPS measurement
    rafId = requestAnimationFrame(measureFPS);
    
    return () => {
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [onFpsUpdate, onGpuUpdate]);
  
  const isLiveRef = useRef(true);
  const feedStageRef = useRef<string>(feedStage);
  const minimapStickyRef = useRef(true); // When true, minimap right edge sticks to latest data
  const minimapTimeWindowRef = useRef(300 * 1000); // Current minimap window width in ms (default 5 min)
  const historyLoadedRef = useRef(false);
  const initialDataTimeRef = useRef<number | null>(null);
  const userInteractedRef = useRef(false);
  const timeWindowSelectedRef = useRef(false); // When true, a time window preset was explicitly selected
  const selectedWindowMinutesRef = useRef<number | null>(null); // Store the selected window size in minutes (null = entire session)
  const sessionModeRef = useRef(false); // When true, show entire session (expand with data)
  const lastDataTimeRef = useRef(0);
  const settingTimeWindowRef = useRef(false); // Flag to prevent auto-scroll from overriding during setTimeWindow
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastYAxisUpdateRef = useRef(0);
  const isCleaningUpOverviewRef = useRef(false);
  const overviewContainerIdRef = useRef<string | null>(null); // Store the container ID used to create overview
  const lastOverviewSourceRef = useRef<{ surfaceId?: string; minimapSourceSeries?: string } | null>(null); // Track last overview source
  const triggerYAxisScalingOnNextBatchRef = useRef(false); // Flag to trigger Y-axis scaling after data is processed
  const yAxisManuallyStretchedRef = useRef(false); // When true, skip auto Y-axis scaling to preserve user's manual stretch
  const prevAutoScrollStateRef = useRef<boolean | null>(null); // Track previous auto-scroll state to detect changes
  const anyPaneHasDataRef = useRef(false); // CRITICAL: Gate auto-scroll until first data arrives
  
  // Track X-axis range state before tab is hidden to restore it when visible again
  const savedXAxisRangeRef = useRef<{
    tickRange: { min: number; max: number; width: number } | null;
    ohlcRange: { min: number; max: number; width: number } | null;
    isFullRange: boolean; // true if showing all data (from earliest to latest)
  } | null>(null);
  
  // Batch samples for performance - accumulate samples and render at 60fps
  const sampleBufferRef = useRef<Sample[]>([]);
  const pendingUpdateRef = useRef<number | NodeJS.Timeout | null>(null);
  const lastRenderTimeRef = useRef(0);
  const isUsingTimeoutRef = useRef(false); // Track if we're using setTimeout vs requestAnimationFrame
  const isRestoringRangeRef = useRef(false); // Flag to prevent auto-scroll from overriding range restoration
  const TARGET_FPS = 60;
  const FRAME_INTERVAL_MS = 1000 / TARGET_FPS;
  
  // REMOVED: Downsampling disabled - all data points are plotted for accuracy
  // SciChart's WebGL rendering handles millions of points efficiently via EResamplingMode.Auto
  // which does GPU-side downsampling for display without losing source data
  

  // Theme configuration - dynamic based on theme prop
  const darkTheme = {
    type: 'Dark' as const,
    axisBorder: 'transparent',
    axisTitleColor: '#9fb2c9',
    annotationsGripsBackgroundBrush: 'transparent',
    annotationsGripsBorderBrush: 'transparent',
    axis3DBandsFill: 'transparent',
    axisBandsFill: 'transparent',
    gridBackgroundBrush: 'transparent',
    gridBorderBrush: 'transparent',
    loadingAnimationBackground: '#1c2027',
    loadingAnimationForeground: '#50C7E0',
    majorGridLineBrush: '#2a3040',
    minorGridLineBrush: '#1e2530',
    sciChartBackground: '#1c2027',
    tickTextBrush: '#9fb2c9',
    labelBackgroundBrush: '#1c2027',
    labelBorderBrush: '#3a424c',
    labelForegroundBrush: '#9fb2c9',
    textAnnotationBackground: '#2a2f36',
    textAnnotationForeground: '#c9d7e6',
    cursorLineBrush: '#50C7E0',
    rolloverLineStroke: '#50C7E0',
  };

  const lightTheme = {
    type: 'Light' as const,
    axisBorder: 'transparent',
    axisTitleColor: '#374151',
    annotationsGripsBackgroundBrush: 'transparent',
    annotationsGripsBorderBrush: 'transparent',
    axis3DBandsFill: 'transparent',
    axisBandsFill: 'transparent',
    gridBackgroundBrush: 'transparent',
    gridBorderBrush: 'transparent',
    loadingAnimationBackground: '#ffffff',
    loadingAnimationForeground: '#3b82f6',
    majorGridLineBrush: '#e5e7eb',
    minorGridLineBrush: '#f3f4f6',
    sciChartBackground: '#ffffff',
    tickTextBrush: '#374151',
    labelBackgroundBrush: '#ffffff',
    labelBorderBrush: '#d1d5db',
    labelForegroundBrush: '#374151',
    textAnnotationBackground: '#f9fafb',
    textAnnotationForeground: '#1f2937',
    cursorLineBrush: '#3b82f6',
    rolloverLineStroke: '#3b82f6',
  };

  const chartTheme = theme === 'dark' ? darkTheme : lightTheme;

  // Initialize charts
  useEffect(() => {
    // Skip legacy initialization if layout is loaded (dynamic panes will be created separately)
    if (plotLayout) {
     
      return;
    }

    let isMounted = true;
    let cancelled = false;

    const initCharts = async () => {
      try {
      
        
        // Wait a bit for layout to potentially load (in case it's loading asynchronously)
        // Check multiple times to catch layout loading
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 50));
          
          // Check if layout was loaded during the wait (check current value, not closure)
          // We need to check the actual DOM or use a different approach
          // For now, just check if containers exist - if they don't, we're using dynamic layout
          const tickContainer = document.getElementById(tickContainerId);
          if (!tickContainer) {
            
            cancelled = true;
            return;
          }
        }
        
        if (cancelled || !isMounted) return;
        
        // Check if containers exist and have dimensions
        const tickContainer = document.getElementById(tickContainerId);
        const ohlcContainer = document.getElementById(ohlcContainerId);
        
        if (!tickContainer) {
          // Container not found - may be using dynamic layout
          return;
        }
        if (!ohlcContainer) {
          // Container not found - may be using dynamic layout
          return;
        }

        // Ensure containers have dimensions
        const tickRect = tickContainer.getBoundingClientRect();
        const ohlcRect = ohlcContainer.getBoundingClientRect();
        
        if (tickRect.width === 0 || tickRect.height === 0) {
          // Tick container has no dimensions yet
          // Wait a bit for layout
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (ohlcRect.width === 0 || ohlcRect.height === 0) {
          // OHLC container has no dimensions yet
          // Wait a bit for layout
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
       
        SciChartSurface.useWasmFromCDN();

        // PERF: Disable DPI scaling for better performance on Retina/High-DPI displays
        // This prevents 4x pixel rendering which significantly improves FPS
        DpiHelper.IsDpiScaleEnabled = false;
        
        // PERF: Enable global performance optimizations (large performance boost)
        SciChartDefaults.useNativeText = true; // Use native WebGL text for better performance
        SciChartDefaults.useSharedCache = true; // Share label cache across charts
        SciChartDefaults.performanceWarnings = false; // Disable perf warnings for production
        
        // Wait for WASM to be fully loaded and initialized
        // This ensures fonts and other systems are ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Also wait for a couple of animation frames to ensure everything is ready
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));

       
        // Create tick/line surface with performance optimizations
        // PERF: freezeWhenOutOfView prevents rendering when scrolled out of viewport
        const tickResult = await SciChartSurface.create(tickContainerId, { 
          theme: chartTheme,
          freezeWhenOutOfView: true,
        });
        if (!isMounted) {
          tickResult.sciChartSurface.delete();
          return;
        }

        const { sciChartSurface: tickSurface, wasmContext: tickWasm } = tickResult;

        // Don't suspend updates initially - let the surface render once to initialize fonts
        // We'll suspend later when adding series

        // Configure tick axes - each pane has its own X-axis
        // Let SciChart use its default intelligent datetime formatting (adapts based on zoom level)
        const tickXAxis = new DateTimeNumericAxis(tickWasm, {
          autoRange: EAutoRange.Once,
          drawMajorGridLines: false, // Disable gridlines for better FPS
          drawMinorGridLines: false,
          isVisible: true, // Each pane has its own visible X-axis
          useNativeText: true,
          useSharedCache: true,
          maxAutoTicks: config.performance.maxAutoTicks,
          // Add styling to make X-axis visible (match new-index.html)
          axisTitle: "Time",
          axisTitleStyle: { color: "#9fb2c9" },
          labelStyle: { color: "#9fb2c9" },
        });

        const tickYAxis = new NumericAxis(tickWasm, {
          autoRange: EAutoRange.Once, // Changed from Always to Once to prevent Y-axis jumping
          drawMajorGridLines: false, // Disable gridlines for better FPS
          drawMinorGridLines: false,
          axisAlignment: EAxisAlignment.Right,
          useNativeText: true, // Use native text for better performance (large improvement)
          useSharedCache: true, // Share label cache
          maxAutoTicks: 10, // Increased from 3 for better Y-axis tick density
          growBy: new NumberRange(0.1, 0.1), // Add 10% padding above and below
          // Add styling to make Y-axis visible (match new-index.html)
          axisTitle: "Price",
          axisTitleStyle: { color: "#9fb2c9" },
          labelStyle: { color: "#9fb2c9" },
        });

        tickSurface.xAxes.add(tickXAxis);
        tickSurface.yAxes.add(tickYAxis);

        // Let the surface render once with just axes to initialize fonts
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
        
        // Now suspend updates while adding series
        tickSurface.suspendUpdates();

        // NOTE: Tick and OHLC series will be created dynamically by registry preallocation
        // No hardcoded series creation - all series go through unified store

        // Resume updates on tick surface and wait for it to render
        // This ensures fonts are initialized before creating the second surface
        tickSurface.resumeUpdates();
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => setTimeout(resolve, 150));

        // Create OHLC surface with performance optimizations
        
        const ohlcResult = await SciChartSurface.create(ohlcContainerId, { 
          theme: chartTheme,
        });
        if (!isMounted) {
          tickSurface.delete();
          ohlcResult.sciChartSurface.delete();
          return;
        }

        const { sciChartSurface: ohlcSurface, wasmContext: ohlcWasm } = ohlcResult;

        // Don't suspend updates initially - let the surface render once to initialize fonts
        // We'll suspend later when adding series

        // Configure OHLC axes - separate X-axis for OHLC pane
        // Let SciChart use its default intelligent datetime formatting (adapts based on zoom level)
        const ohlcXAxis = new DateTimeNumericAxis(ohlcWasm, {
          autoRange: EAutoRange.Once,
          drawMajorGridLines: false, // Disable gridlines for better FPS
          drawMinorGridLines: false,
          isVisible: true, // Each pane has its own visible X-axis
          useNativeText: true, // Use native text for better performance
          useSharedCache: true, // Share label cache
          maxAutoTicks: config.performance.maxAutoTicks, // Allow more ticks for adaptive zoom-based labels
          // Don't set majorDelta/minorDelta - let SciChart adapt based on zoom level!
          // Add styling to make X-axis visible (match new-index.html)
          axisTitle: "Time",
          axisTitleStyle: { color: "#9fb2c9" },
          labelStyle: { color: "#9fb2c9" },
        });

        const ohlcYAxis = new NumericAxis(ohlcWasm, {
          autoRange: EAutoRange.Once, // Changed from Always to Once to prevent Y-axis jumping
          drawMajorGridLines: false, // Disable gridlines for better FPS
          drawMinorGridLines: false,
          axisAlignment: EAxisAlignment.Right,
          useNativeText: true, // Use native text for better performance
          useSharedCache: true, // Share label cache
          maxAutoTicks: 10, // Increased from 3 for better Y-axis tick density
          growBy: new NumberRange(0.1, 0.1), // Add 10% padding above and below
          // Add styling to make Y-axis visible (match new-index.html)
          axisTitle: "Price",
          axisTitleStyle: { color: "#9fb2c9" },
          labelStyle: { color: "#9fb2c9" },
        });

        ohlcSurface.xAxes.add(ohlcXAxis);
        ohlcSurface.yAxes.add(ohlcYAxis);

        // Let the surface render once with just axes to initialize fonts
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));
        
        // Now suspend updates while adding series
        ohlcSurface.suspendUpdates();

        // NOTE: OHLC series will be created dynamically by registry preallocation

        // Add modifiers to both surfaces - essential modifiers for good UX
        const addModifiers = (surface: SciChartSurface, wasm: TSciChart) => {
          // Add axis drag modifiers for stretching/shrinking axes
          surface.chartModifiers.add(
            new XAxisDragModifier(), // Drag on X-axis to stretch/shrink
            new YAxisDragModifier(), // Drag on Y-axis to stretch/shrink
          );
          
          // Add zoom/pan modifiers
          // NOTE: ZoomExtentsModifier is NOT added here - we handle double-click ourselves
          // to have full control over the behavior (especially in paused mode)
          surface.chartModifiers.add(
            new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection }),
            new RubberBandXyZoomModifier({ isAnimated: false }), // Box zoom without animation for performance
            new ZoomPanModifier({ 
              executeCondition: { button: EExecuteOn.MouseRightButton } 
            }) // Right-click drag to pan
          );
        };

        addModifiers(tickSurface, tickWasm);
        addModifiers(ohlcSurface, ohlcWasm);
        
        // Remove ZoomExtentsModifier from legacy surfaces - we handle double-click ourselves
        setTimeout(() => {
          const tickModifiers = tickSurface.chartModifiers.asArray();
          const ohlcModifiers = ohlcSurface.chartModifiers.asArray();
          for (const mod of [...tickModifiers, ...ohlcModifiers]) {
            if (mod instanceof ZoomExtentsModifier) {
              if (tickModifiers.includes(mod)) {
                tickSurface.chartModifiers.remove(mod);
              }
              if (ohlcModifiers.includes(mod)) {
                ohlcSurface.chartModifiers.remove(mod);
              }
            }
          }
        }, 100);

        // REQUIREMENT: All charts must have linked X-axes
        // Always create vertical group to link X-axes across all panes
        let verticalGroup: SciChartVerticalGroup | null = null;
        verticalGroup = new SciChartVerticalGroup();
        verticalGroup.addSurfaceToGroup(tickSurface);
        verticalGroup.addSurfaceToGroup(ohlcSurface);

        // FPS tracking is now handled by requestAnimationFrame at the top level
        // No need to subscribe to surface rendered events

        // User interaction detection
        const markInteracted = () => {
          userInteractedRef.current = true;
          if (interactionTimeoutRef.current) {
            clearTimeout(interactionTimeoutRef.current);
          }
          // CRITICAL: Reduce timeout and respect live mode toggle
          // If live mode is explicitly enabled, clear interaction flag immediately
          interactionTimeoutRef.current = setTimeout(() => {
            // Only clear if live mode is still enabled (user might have toggled it off)
            if (isLiveRef.current) {
              userInteractedRef.current = false;
            }
          }, 5000); // Reduced from 10s to 5s for better responsiveness
        };

        [tickSurface.domCanvas2D, ohlcSurface.domCanvas2D].forEach(canvas => {
          if (canvas) {
            ['mousedown', 'wheel', 'touchstart'].forEach(evt => {
              canvas.addEventListener(evt, markInteracted, { passive: true });
            });
          }
        });

        // Overview will be created by separate useEffect when overviewContainerId is available
        // This allows it to be created/destroyed dynamically when minimap is toggled
        let overview: SciChartOverview | null = null;

        // Resume updates now that everything is set up
        tickSurface.resumeUpdates();
        ohlcSurface.resumeUpdates();

        // Store refs
        chartRefs.current = {
          tickSurface,
          ohlcSurface,
          tickWasm,
          ohlcWasm,
          // Unified DataSeries Store - will be populated by registry preallocation
          dataSeriesStore: new Map<string, DataSeriesEntry>(),
          verticalGroup,
          overview,
          // Dynamic pane surfaces (empty initially, populated when layout is loaded)
          paneSurfaces: new Map<string, PaneSurface>(),
          // Shared WASM context (will be set from first pane when dynamic panes are created)
          sharedWasm: null,
          // Strategy marker scatter series per pane (5 series per pane)
          markerScatterSeries: new Map<string, Map<MarkerSeriesType, MarkerScatterGroup>>(),
          markerSampleHistory: [],
          seriesHasData: new Map<string, boolean>(),
          waitingAnnotations: new Map<string, TextAnnotation>(),
        };

        // Note: Axis titles are intentionally omitted during initialization
        // to avoid font measurement errors. Titles can be added later once
        // the chart is fully rendered and fonts are initialized.
        // To add titles later, use: tickYAxis.axisTitle = 'Price';

        setIsReady(true);
        onReadyChange?.(true);
       

      } catch (error) {
        // Silently handle initialization errors (surfaces may not exist yet)
        // Set ready to false to show error state
        setIsReady(false);
      }
    };

    initCharts();

    return () => {
      isMounted = false;
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      if (pendingUpdateRef.current !== null) {
        if (isUsingTimeoutRef.current) {
          clearTimeout(pendingUpdateRef.current as NodeJS.Timeout);
        } else {
          cancelAnimationFrame(pendingUpdateRef.current as number);
        }
        pendingUpdateRef.current = null;
      }
      // Delete main chart surfaces first
      chartRefs.current.tickSurface?.delete();
      chartRefs.current.ohlcSurface?.delete();
      // Then delete overview - it shares DataSeries, so must be deleted after main surfaces
      // This ensures the main chart's DataSeries are cleaned up first
      if (chartRefs.current.overview) {
        chartRefs.current.overview.delete();
        lastOverviewSourceRef.current = null;
      }
    };
  }, [tickContainerId, ohlcContainerId, plotLayout, overviewContainerId, isReady, registry]);

  // Handle overview/minimap creation/destruction when toggled
  // IMPORTANT: We use a separate useEffect for hide/show that doesn't trigger cleanup
  useEffect(() => {
    const refs = chartRefs.current;

    // For multi_surface layouts, we create a standalone minimap surface with CLONED DataSeries
    // This avoids the "dataSeries has been deleted" error caused by SciChartOverview sharing DataSeries
    const isMultiSurface = plotLayout?.layout?.layout_mode === 'multi_surface';
    
    // For dynamic layouts, we don't need tickSurface - we'll find the correct surface from the layout
    // For legacy layouts, we need tickSurface
    const hasLegacySurface = !!refs.tickSurface;
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    
    if (!hasLegacySurface && !hasDynamicPanes) {
      // No surfaces available yet
      return;
    }
    
    if (!isReady) return;

    let isCancelled = false;

    const handleOverview = async () => {
      if (!overviewContainerId) {
        return;
      }
      
      try {
        // CRITICAL: Delete existing minimap/overview when theme changes to force recreation
        // This ensures the minimap always uses the correct theme
        if (isMultiSurface && (refs as any).minimapSurface) {
          const minimapSurf = (refs as any).minimapSurface as SciChartSurface;
          try {
            // Clean up range modifier
            const rangeModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
            if (rangeModifier && minimapSurf?.chartModifiers) {
              minimapSurf.chartModifiers.remove(rangeModifier);
              (refs as any).minimapRangeSelectionModifier = null;
            }
            // Clean up axis subscription
            const axisSubscription = (refs as any).minimapAxisSubscription;
            if (axisSubscription) {
              try {
                axisSubscription.unsubscribe();
              } catch (e) {
                console.warn('[MultiPaneChart] Error cleaning up minimap axis subscription:', e);
              }
              (refs as any).minimapAxisSubscription = null;
            }
            // Delete surface
            minimapSurf.suspendUpdates();
            minimapSurf.renderableSeries.clear();
            minimapSurf.delete();
          } catch (e) {
            console.warn('[MultiPaneChart] Error deleting minimap for theme change:', e);
          }
          (refs as any).minimapSurface = null;
          (refs as any).minimapDataSeries = null;
          (refs as any).minimapXAxis = null;
          (refs as any).minimapSourceSeriesId = null;
          (refs as any).minimapTargetPaneId = null;
        } else if (refs.overview) {
          // For legacy overview, delete and recreate
          try {
            refs.overview.delete();
            refs.overview = null;
            lastOverviewSourceRef.current = null;
          } catch (e) {
            console.warn('[MultiPaneChart] Error deleting overview for theme change:', e);
          }
        }
        
        // Wait a bit to ensure the container is rendered
        await new Promise(resolve => setTimeout(resolve, 100));
        
        if (isCancelled) return;
        
        const overviewContainer = document.getElementById(overviewContainerId);
        if (!overviewContainer) {
          console.warn(`[MultiPaneChart] Overview container not found: ${overviewContainerId}`);
          return;
        }

        // Get minimap source series ID from layout
        const minimapSourceSeriesId = plotLayout?.minimapSourceSeries;
        
        if (isMultiSurface) {
          // === MULTI-SURFACE MODE: Create standalone surface with cloned DataSeries ===
          console.log('[MultiPaneChart] Creating standalone minimap for multi_surface layout');
          
          // Delete existing overview/minimap if any (additional cleanup)
          if (refs.overview) {
            try {
              refs.overview.delete();
            } catch (e) {
              console.warn('[MultiPaneChart] Error deleting old overview:', e);
            }
            refs.overview = null;
          }
          if ((refs as any).minimapSurface) {
            try {
              // CRITICAL: Clean up OverviewRangeSelectionModifier BEFORE deleting surface
              const rangeModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
              if (rangeModifier) {
                try {
                  // Detach the callback to prevent memory access
                  rangeModifier.onSelectedAreaChanged = undefined as any;
                  // Remove from chart modifiers
                  const minimapSurf = (refs as any).minimapSurface as SciChartSurface;
                  if (minimapSurf?.chartModifiers) {
                    minimapSurf.chartModifiers.remove(rangeModifier);
                  }
                } catch (e) {
                  console.warn('[MultiPaneChart] Error cleaning up range modifier:', e);
                }
                (refs as any).minimapRangeSelectionModifier = null;
              }
              
              // Clean up axis subscription before deleting surface
              const axisSubscription = (refs as any).minimapAxisSubscription;
              if (axisSubscription) {
                try {
                  axisSubscription.unsubscribe();
                } catch (e) {
                  console.warn('[MultiPaneChart] Error cleaning up minimap axis subscription:', e);
                }
                (refs as any).minimapAxisSubscription = null;
              }
              
              // Suspend updates before delete to prevent render during cleanup
              const minimapSurf = (refs as any).minimapSurface as SciChartSurface;
              try {
                minimapSurf.suspendUpdates();
              } catch (e) {}
              
              // Clear renderableSeries and detach dataSeries references
              try {
                for (let i = minimapSurf.renderableSeries.size() - 1; i >= 0; i--) {
                  const rs = minimapSurf.renderableSeries.get(i);
                  (rs as any).dataSeries = null;
                }
                minimapSurf.renderableSeries.clear();
              } catch (e) {}
              
              // Delete the surface
              minimapSurf.delete();
            } catch (e) {
              console.warn('[MultiPaneChart] Error deleting old minimap surface:', e);
            }
            (refs as any).minimapSurface = null;
            (refs as any).minimapDataSeries = null;
            (refs as any).minimapXAxis = null;
            (refs as any).minimapSourceSeriesId = null;
            (refs as any).minimapTargetPaneId = null;
          }
          
          // CRITICAL: Wait for cleanup to complete before creating new minimap
          await new Promise(resolve => setTimeout(resolve, 100));
          
          // Get data from dataSeriesStore for the minimap source series
          if (!minimapSourceSeriesId) {
            console.warn('[MultiPaneChart] No minimap source series specified in layout');
            return;
          }
          
          const seriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
          const sourceDataSeries = seriesEntry?.dataSeries as XyDataSeries | undefined;
          
          // CRITICAL: Create minimap even if source series doesn't exist yet
          // The minimap will be populated as data arrives via processBatchedSamples
          let pointCount = 0;
          if (sourceDataSeries) {
            try {
              pointCount = sourceDataSeries.count();
            } catch (e) {
              console.warn('[MultiPaneChart] Error getting source series count:', e);
            }
          }
          
          if (!seriesEntry) {
            console.log('[MultiPaneChart] Minimap source series not in dataSeriesStore yet, creating empty minimap (will populate as data arrives)');
          } else if (pointCount === 0) {
            console.log('[MultiPaneChart] Minimap source series has no data yet, creating empty minimap (will populate as data arrives)');
          } else {
            console.log(`[MultiPaneChart] Creating minimap with ${pointCount} data points from source series ${minimapSourceSeriesId}`);
          }
          
          // Create standalone minimap surface
          const { sciChartSurface: minimapSurface, wasmContext: minimapWasm } = await SciChartSurface.create(overviewContainerId, {
            theme: chartTheme,
          });
          
          if (isCancelled) {
            minimapSurface.delete();
            return;
          }
          
          // Configure axes for minimap - hide X-axis labels, show full data range
          // CRITICAL: autoRange must be Never and growBy must be 0 to prevent the axis from changing
          // The OverviewRangeSelectionModifier calculates overlay based on axis.visibleRange,
          // so the axis must ALWAYS show the full data range
          const xAxis = new DateTimeNumericAxis(minimapWasm, {
            axisTitle: '',
            drawLabels: false, // Hide labels - user wants range indicator, not axis numbers
            drawMinorTickLines: false,
            drawMajorTickLines: false, // Hide tick lines - cleaner look
            drawMajorGridLines: false,
            drawMinorGridLines: false,
            autoRange: EAutoRange.Never, // CRITICAL: Never auto-range - we manually set to full data range
            isVisible: false, // Hide the axis itself - we only want the range indicator
            growBy: new NumberRange(0, 0), // CRITICAL: No growBy - keep range exactly as set
          });
          
          const yAxis = new NumericAxis(minimapWasm, {
            axisTitle: '',
            drawLabels: false,
            drawMinorTickLines: false,
            drawMajorTickLines: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false,
            autoRange: EAutoRange.Always,
          });
          
          minimapSurface.xAxes.add(xAxis);
          minimapSurface.yAxes.add(yAxis);
          
          // CRITICAL: Minimap should NOT have any modifiers that allow changing the X-axis range
          // The minimap X-axis is locked to show full data range
          // Users will interact via a range indicator (BoxAnnotation) that we'll add below
          // Do NOT add XAxisDragModifier - it causes the minimap to change its range
          // minimapSurface.chartModifiers.add(...) - REMOVED to prevent minimap from changing
          
          // Create cloned DataSeries by copying from source
          // IMPORTANT: minimap must keep the FULL session for its source series.
          // Using a small FIFO here will drop old points, making the minimap look like it
          // doesn't show the full data range.
          const minimapCapacity =
            config.data?.buffers.maxPointsTotal ??
            config.data?.buffers.pointsPerSeries ??
            2_000_000;

          const clonedDataSeries = new XyDataSeries(minimapWasm, {
            fifoCapacity: minimapCapacity,
            isSorted: true,
            containsNaN: false,
          });
          
          // Copy data from source DataSeries to cloned series (only if source exists)
          // CRITICAL: Use safe method to avoid memory access errors
          let copiedCount = 0;
          if (sourceDataSeries) {
            try {
              const count = sourceDataSeries.count();
              if (count > 0) {
                // Use getNativeXValues/getNativeYValues safely with bounds checking
                const nativeX = sourceDataSeries.getNativeXValues();
                const nativeY = sourceDataSeries.getNativeYValues();
                
                // CRITICAL: Check bounds before accessing native arrays
                if (nativeX && nativeY && nativeX.size() > 0 && nativeX.size() === nativeY.size()) {
                  // Convert to arrays and append
                  const xArr: number[] = [];
                  const yArr: number[] = [];
                  const size = Math.min(nativeX.size(), count); // Use minimum to avoid out of bounds
                  for (let i = 0; i < size; i++) {
                    try {
                      const x = nativeX.get(i);
                      const y = nativeY.get(i);
                      if (isFinite(x) && isFinite(y)) {
                        xArr.push(x);
                        yArr.push(y);
                      }
                    } catch (e) {
                      // Skip invalid values to avoid memory errors
                      console.warn(`[Minimap] Skipping invalid data point at index ${i}:`, e);
                      break; // Stop if we hit an error
                    }
                  }
                  if (xArr.length > 0) {
                    clonedDataSeries.appendRange(xArr, yArr);
                    copiedCount = xArr.length;
                  }
                } else {
                  // Fallback: Use getXRange and iterate if native access fails
                  console.warn('[Minimap] Native array access failed, using fallback method');
                  const xRange = sourceDataSeries.getXRange();
                  if (xRange) {
                    // For large datasets, we might need to sample, but for now just log
                    console.warn('[Minimap] Source series has data but native access failed');
                  }
                }
              }
            } catch (e) {
              console.error('[Minimap] Error copying data from source series:', e);
              // Continue with empty minimap - it will be populated as new data arrives
            }
          }
          
          // Add line series for minimap
          const lineSeries = new FastLineRenderableSeries(minimapWasm, {
            dataSeries: clonedDataSeries,
            stroke: '#4CAF50',
            strokeThickness: 1,
          });
          minimapSurface.renderableSeries.add(lineSeries);
          
          // CRITICAL: Set X-axis range AFTER data series is created but BEFORE creating OverviewRangeSelectionModifier
          // The modifier reads the axis range when it's created/added, so it must be set first
          // Initialize minimap X-axis to show FULL data range
          let fullDataRangeForAxis: NumberRange | undefined;
          if (clonedDataSeries && clonedDataSeries.count() > 0) {
            const dataRange = clonedDataSeries.getXRange();
            if (dataRange) {
              fullDataRangeForAxis = new NumberRange(dataRange.min, dataRange.max);
            }
          }
          
          // Set minimap to show full range - CRITICAL: use wide range if no data yet
          // CRITICAL: The X-axis range MUST be set to full data range for OverviewRangeSelectionModifier
          // to calculate the overlay correctly. The overlay covers from axis.min to selectedRange.min
          // (left) and from selectedRange.max to axis.max (right)
          if (fullDataRangeForAxis) {
            xAxis.visibleRange = fullDataRangeForAxis;
            // CRITICAL: Disable autoRange and set growBy to 0 to prevent it from changing
            (xAxis as any).autoRange = EAutoRange.Never;
            xAxis.growBy = new NumberRange(0, 0);
            console.log(`[Minimap] Set X-axis range BEFORE modifier: ${new Date(fullDataRangeForAxis.min).toISOString()} to ${new Date(fullDataRangeForAxis.max).toISOString()}`);
          } else {
            // No data yet - use a wide initial range that will be updated as data arrives
            const now = Date.now() / 1000; // Convert to seconds for consistency
            const wideRange = new NumberRange(now - 60 * 60, now + 5 * 60); // Last hour + 5min buffer (in seconds)
            xAxis.visibleRange = wideRange;
            // CRITICAL: Disable autoRange and set growBy to 0 to prevent it from changing
            (xAxis as any).autoRange = EAutoRange.Never;
            xAxis.growBy = new NumberRange(0, 0);
            console.log(`[Minimap] Set X-axis range (no data yet) BEFORE modifier`);
          }
          
          // Find the pane that contains the minimap source series (only this pane syncs with minimap)
          const sourceSeriesAssignment = plotLayout?.layout.series.find(
            s => s.series_id === minimapSourceSeriesId
          );
          const targetPaneId = sourceSeriesAssignment?.pane || seriesEntry.paneId;
          
          // Get the target pane's current visible X range to initialize the selection
          let initialSelectedArea: NumberRange | undefined;
          const targetPaneSurface = targetPaneId ? refs.paneSurfaces.get(targetPaneId) : null;
          if (targetPaneSurface?.xAxis?.visibleRange) {
            initialSelectedArea = new NumberRange(
              targetPaneSurface.xAxis.visibleRange.min,
              targetPaneSurface.xAxis.visibleRange.max
            );
          }

          // === OFFICIAL SCICHART PATTERN: OverviewRangeSelectionModifier ===
          // Create the range selection modifier (draggable range indicator)
          // The overlay (unselected areas) is automatically calculated based on the X-axis visible range
          // CRITICAL: The minimap X-axis must always show the full data range so the overlay
          // correctly covers from axis.min to selectedRange.min (left) and 
          // from selectedRange.max to axis.max (right)
          const rangeSelectionModifier = new OverviewRangeSelectionModifier();
          
          // CRITICAL: Customize overlay SVG strings to ensure proper rendering
          // Following SciChart instructions: set both SVG strings with width="100%" and height="100%"
          // This ensures the overlay covers all unselected areas correctly (left and right)
          try {
            // Set the selected area annotation SVG (the selected range indicator)
            if ((rangeSelectionModifier as any).rangeSelectionAnnotation) {
              (rangeSelectionModifier as any).rangeSelectionAnnotation.svgString = `
                <rect width="100%" height="100%" fill="rgba(10, 111, 194, 0.3)" />
              `;
            }
            
            // CRITICAL: Set the unselected area overlay SVG (left and right overlays)
            // This MUST have width="100%" and height="100%" to cover the full area
            if ((rangeSelectionModifier as any).unselectedSvgString !== undefined) {
              (rangeSelectionModifier as any).unselectedSvgString = `
                <rect width="100%" height="100%" fill="rgba(0, 0, 0, 0.4)" />
              `;
            }
            
            console.log('[MultiPaneChart] Set overlay SVG strings with width="100%" and height="100%"');
          } catch (e) {
            console.warn('[MultiPaneChart] Could not customize overlay SVG strings:', e);
          }
          
          // Initialize the selected area from main chart visible range
          if (initialSelectedArea) {
            rangeSelectionModifier.selectedArea = initialSelectedArea;
          } else {
            // Default to showing last 2 minutes if no initial range (in SECONDS for SciChart)
            const nowSec = Date.now() / 1000;
            rangeSelectionModifier.selectedArea = new NumberRange(nowSec - 2 * 60, nowSec);
          }
          
          // Helper function to apply X range to all linked charts
          const applyLinkedXRange = (range: NumberRange) => {
            // Dynamic panes
            for (const [, paneSurface] of refs.paneSurfaces) {
              try {
                (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
                paneSurface.xAxis.growBy = new NumberRange(0, 0);
                paneSurface.xAxis.visibleRange = range;
              } catch {}
            }

            // Legacy surfaces
            try {
              const tickXAxis = refs.tickSurface?.xAxes.get(0);
              if (tickXAxis) {
                (tickXAxis as any).autoRange = EAutoRange.Never;
                tickXAxis.growBy = new NumberRange(0, 0);
                tickXAxis.visibleRange = range;
              }
            } catch {}
            try {
              const ohlcXAxis = refs.ohlcSurface?.xAxes.get(0);
              if (ohlcXAxis) {
                (ohlcXAxis as any).autoRange = EAutoRange.Never;
                ohlcXAxis.growBy = new NumberRange(0, 0);
                ohlcXAxis.visibleRange = range;
              }
            } catch {}

            // Invalidate
            try { refs.tickSurface?.invalidateElement(); } catch {}
            try { refs.ohlcSurface?.invalidateElement(); } catch {}
            for (const [, paneSurface] of refs.paneSurfaces) {
              try { paneSurface.surface.invalidateElement(); } catch {}
            }

            // Notify toolbar
            onTimeWindowChanged?.({
              minutes: selectedWindowMinutesRef.current ?? 0,
              startTime: range.min,
              endTime: range.max,
            });
          };

          // Flag to prevent re-entry when programmatically setting selectedArea
          let updatingMinimapProgrammatically = false;
          
          // When the range selection is moved/resized, update the linked main charts.
          // If the user positions the right edge at/near the far-right of the data, we treat this as
          // "follow latest" and keep live+sticky enabled.
          rangeSelectionModifier.onSelectedAreaChanged = (selectedRange: NumberRange) => {
            // CRITICAL: Skip if we're programmatically updating selectedArea to prevent re-entry loop
            if (updatingMinimapProgrammatically) {
              return;
            }
            
            // CRITICAL: Do NOT block minimap changes when toolbar time window is selected
            // Allow minimap to override toolbar selection - user interaction should always win
            // Clear toolbar selection immediately so auto-scroll uses minimap window
            settingTimeWindowRef.current = false;
            selectedWindowMinutesRef.current = null; // Clear toolbar selection
            sessionModeRef.current = false; // Disable "entire session" mode when user manually drags minimap

            // CRITICAL: Ensure minimap X-axis shows full data range so overlay is calculated correctly
            // The overlay should always be from axis.min to selectedRange.min (left) and 
            // from selectedRange.max to axis.max (right), not moving with the selection
            // MUST happen BEFORE processing the selectedRange to ensure overlay is correct
            // CRITICAL: We MUST ALWAYS set the axis range to full data range, even if it seems correct
            // The modifier may be using a cached or incorrect range if we don't explicitly set it
            const minimapXAxis = (refs as any).minimapXAxis as DateTimeNumericAxis | null;
            const minimapSurface = (refs as any).minimapSurface as SciChartSurface | null;
            const mmDs = (refs as any).minimapDataSeries as XyDataSeries | null;
            if (minimapXAxis && minimapSurface && mmDs) {
              try {
                // Always get the full data range - even if count is 0, use axis range as fallback
                let fullDataRange: NumberRange | null = null;
                if (mmDs.count() > 0) {
                  const dataRange = mmDs.getXRange();
                  if (dataRange) {
                    fullDataRange = new NumberRange(dataRange.min, dataRange.max);
                  }
                }
                
                // Fallback to current axis range if no data yet
                if (!fullDataRange && minimapXAxis.visibleRange) {
                  fullDataRange = new NumberRange(
                    minimapXAxis.visibleRange.min,
                    minimapXAxis.visibleRange.max
                  );
                }
                
                if (fullDataRange) {
                  const currentAxisRange = minimapXAxis.visibleRange;
                  const axisNeedsUpdate = !currentAxisRange || 
                      Math.abs(currentAxisRange.min - fullDataRange.min) > 0.1 ||
                      Math.abs(currentAxisRange.max - fullDataRange.max) > 0.1;
                  
                  // CRITICAL: ALWAYS set the axis range to full data range, even if it seems unchanged
                  // The modifier may be using a stale range if we don't explicitly update it
                  // Batch updates to ensure the change is applied before the modifier recalculates
                  minimapSurface.suspendUpdates();
                  
                  // Set these properties to prevent any automatic changes
                  (minimapXAxis as any).autoRange = EAutoRange.Never;
                  minimapXAxis.growBy = new NumberRange(0, 0);
                  minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);
                  
                  // Debug logging to verify axis range is correct
                  if (axisNeedsUpdate) {
                    console.log(`[Minimap] Updated X-axis range in onSelectedAreaChanged: ${new Date(fullDataRange.min).toISOString()} to ${new Date(fullDataRange.max).toISOString()}`);
                  }
                  
                  // Resume updates
                  minimapSurface.resumeUpdates();
                  
                  // CRITICAL: Small delay to ensure axis range is fully applied before modifier processes selection
                  // This ensures the modifier reads the correct axis range when calculating overlay
                  setTimeout(() => {
                    // Verify axis range is still correct after delay
                    const verifyRange = minimapXAxis.visibleRange;
                    if (verifyRange) {
                      const diff = Math.abs(verifyRange.min - fullDataRange.min) + Math.abs(verifyRange.max - fullDataRange.max);
                      if (diff > 0.1) {
                        console.warn(`[Minimap] ⚠️ Axis range changed after update! Expected: ${fullDataRange.min}-${fullDataRange.max}, Got: ${verifyRange.min}-${verifyRange.max}`);
                        // Force it back
                        minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);
                      }
                    }
                    minimapSurface.invalidateElement();
                  }, 0);
                }
              } catch (e) {
                console.warn('[MultiPaneChart] Error ensuring minimap X-axis range:', e);
                if (minimapSurface) {
                  minimapSurface.resumeUpdates();
                }
              }
            }

            // Get current data range from minimap data series (already in seconds)
            let dataMin = 0;
            let dataMax = 0;
            try {
              if (mmDs) {
                const xRange = mmDs.getXRange();
                if (xRange) {
                  if (isFinite(xRange.min)) dataMin = xRange.min;
                  if (isFinite(xRange.max)) dataMax = xRange.max;
                }
              }
              // Fallback to axis range if data series range is not available
              if ((dataMin === 0 && dataMax === 0) && minimapXAxis?.visibleRange) {
                dataMin = minimapXAxis.visibleRange.min;
                dataMax = minimapXAxis.visibleRange.max;
              }
            } catch {}

            // CRITICAL: Clamp selectedRange to data boundaries to prevent edges from going outside
            // Left edge should not go before dataMin, right edge should not go after dataMax
            // Use a small tolerance to prevent flickering when edge is exactly at boundary
            const boundaryTolerance = 0.01; // Small tolerance to prevent flickering
            let clampedMin = selectedRange.min;
            let clampedMax = selectedRange.max;
            let needsClamping = false;
            
            // Only clamp if significantly outside boundaries (using tolerance)
            if (selectedRange.min < dataMin - boundaryTolerance) {
              clampedMin = dataMin;
              needsClamping = true;
            } else if (selectedRange.min < dataMin) {
              // Already very close to boundary, just snap to it without triggering update
              clampedMin = dataMin;
            }
            
            if (selectedRange.max > dataMax + boundaryTolerance) {
              clampedMax = dataMax;
              needsClamping = true;
            } else if (selectedRange.max > dataMax) {
              // Already very close to boundary, just snap to it without triggering update
              clampedMax = dataMax;
            }
            
            // Ensure minimum width is maintained (prevent invalid ranges)
            const minWidth = 0.001;
            if (clampedMax - clampedMin < minWidth) {
              // If clamping made the range too small, adjust to maintain minimum width
              if (selectedRange.min < dataMin) {
                // Left edge was dragged too far left - keep right edge, adjust left
                clampedMin = clampedMax - minWidth;
                if (clampedMin < dataMin) {
                  clampedMin = dataMin;
                  clampedMax = dataMin + minWidth;
                }
                needsClamping = true;
              } else if (selectedRange.max > dataMax) {
                // Right edge was dragged too far right - keep left edge, adjust right
                clampedMax = clampedMin + minWidth;
                if (clampedMax > dataMax) {
                  clampedMax = dataMax;
                  clampedMin = dataMax - minWidth;
                }
                needsClamping = true;
              }
            }

            // Only update if range was significantly clamped (outside tolerance)
            // This prevents flickering when edge is already at or very close to boundary
            if (needsClamping && (Math.abs(clampedMin - selectedRange.min) > boundaryTolerance || 
                                  Math.abs(clampedMax - selectedRange.max) > boundaryTolerance)) {
              updatingMinimapProgrammatically = true;
              try {
                const clampedRange = new NumberRange(clampedMin, clampedMax);
                rangeSelectionModifier.selectedArea = clampedRange;
                // Use clamped range for further processing
                selectedRange = clampedRange;
              } catch (e) {
                console.warn('[MultiPaneChart] Error updating clamped range:', e);
              }
              updatingMinimapProgrammatically = false;
            } else if (clampedMin !== selectedRange.min || clampedMax !== selectedRange.max) {
              // Small adjustment - just use clamped values without triggering update
              selectedRange = new NumberRange(clampedMin, clampedMax);
            }

            // Remember user-chosen window width for live sticky tracking (in SECONDS since data is in seconds)
            const widthSec = Math.max(0.001, selectedRange.max - selectedRange.min);
            minimapTimeWindowRef.current = widthSec * 1000; // Store as ms for ref compatibility

            // SMOOTHER STICKY DETECTION:
            // Use a VERY generous threshold - 10% of window width or minimum 5 seconds
            const stickyThresholdSec = Math.max(widthSec * 0.10, 5);
            const distanceFromRight = dataMax - selectedRange.max;
            
            // Check if already snapped to right edge (within small tolerance)
            const alreadySnappedToRight = Math.abs(selectedRange.max - dataMax) < 0.1;
            
            // Sticky if right edge is within threshold of data max
            const shouldStickRight = dataMax > 0 && distanceFromRight >= -stickyThresholdSec && distanceFromRight <= stickyThresholdSec;

            if (shouldStickRight) {
              // Only snap if not already snapped to prevent flickering
              if (!alreadySnappedToRight) {
                minimapStickyRef.current = true;
                isLiveRef.current = true;
                userInteractedRef.current = false;
                
                // LIVE MODE: Immediately snap indicator's right edge to dataMax
                const snappedRange = new NumberRange(dataMax - widthSec, dataMax);
                applyLinkedXRange(snappedRange);
                
                // Update the selectedArea to reflect the snapped position (with re-entry guard)
                updatingMinimapProgrammatically = true;
                try {
                  rangeSelectionModifier.selectedArea = snappedRange;
                } catch {}
                updatingMinimapProgrammatically = false;
                
                // Notify toolbar (convert seconds to ms for display)
                const windowMinutes = widthSec / 60;
                onTimeWindowChanged?.({
                  minutes: windowMinutes,
                  startTime: snappedRange.min * 1000,
                  endTime: snappedRange.max * 1000,
                });
                return;
              } else {
                // Already snapped - just update flags without changing range
                minimapStickyRef.current = true;
                isLiveRef.current = true;
                userInteractedRef.current = false;
              }
            } else {
              minimapStickyRef.current = false;
              isLiveRef.current = false;
              userInteractedRef.current = true;
            }

            applyLinkedXRange(selectedRange);
            
            // Notify toolbar (convert seconds to ms for display)
            const windowMinutes = widthSec / 60;
            onTimeWindowChanged?.({
              minutes: windowMinutes,
              startTime: selectedRange.min * 1000,
              endTime: selectedRange.max * 1000,
            });
          };
          
          // Store reference for re-entry guard access from auto-scroll
          (refs as any).updatingMinimapProgrammatically = () => updatingMinimapProgrammatically;
          (refs as any).setUpdatingMinimapProgrammatically = (val: boolean) => { updatingMinimapProgrammatically = val; };
          
          // Following SciChart reference example pattern:
          // Step 5: Add modifier to minimap surface
          minimapSurface.chartModifiers.add(rangeSelectionModifier);
          
          // Store reference for external updates (setTimeWindow, auto-scroll, etc.)
          (refs as any).minimapRangeSelectionModifier = rangeSelectionModifier;
          
          // NOTE: We do NOT subscribe to main chart X-axis changes
          // The minimap indicator stays where user positioned it (sticky behavior)
          // Only user dragging the indicator or time window presets should move it
          (refs as any).minimapAxisSubscription = null;
          
          // Following SciChart reference example pattern:
          // Step 6: Set minimap X axis visibleRange to full data range AFTER adding modifier
          // The axis range should be set to the full data range for the overlay to work correctly
          // Note: This was already set above (before modifier), but we ensure it's correct here
          // The reference example shows setting it after adding modifier works correctly
          if (fullDataRangeForAxis) {
            // Ensure it's still set correctly
            xAxis.visibleRange = fullDataRangeForAxis;
            (xAxis as any).autoRange = EAutoRange.Never;
            xAxis.growBy = new NumberRange(0, 0);
            console.log(`[Minimap] Verified X-axis range (full data): ${new Date(fullDataRangeForAxis.min).toISOString()} to ${new Date(fullDataRangeForAxis.max).toISOString()}`);
          } else {
            // No data yet - ensure wide range is set
            const now = Date.now() / 1000;
            const wideRange = new NumberRange(now - 60 * 60, now + 5 * 60);
            xAxis.visibleRange = wideRange;
            (xAxis as any).autoRange = EAutoRange.Never;
            xAxis.growBy = new NumberRange(0, 0);
            console.log(`[Minimap] Verified X-axis range (no data yet)`);
          }
          
          // CRITICAL: Invalidate surface after setting up modifier and axis range
          // Following reference example pattern - this ensures the overlay is calculated correctly
          minimapSurface.invalidateElement();
          
          // CRITICAL: Ensure autoRange is disabled and won't change
          // This is essential for the overlay to work correctly
          try {
            (xAxis as any).autoRange = EAutoRange.Never;
            xAxis.growBy = new NumberRange(0, 0);
          } catch (e) {
            console.warn('[MultiPaneChart] Error setting minimap X-axis properties:', e);
          }
          
          // Store references for updates and cleanup
          (refs as any).minimapSurface = minimapSurface;
          (refs as any).minimapDataSeries = clonedDataSeries;
          (refs as any).minimapSourceSeriesId = minimapSourceSeriesId;
          (refs as any).minimapTargetPaneId = targetPaneId;
          (refs as any).minimapXAxis = xAxis;
          
          // CRITICAL: If minimap was created with no data but source exists, trigger a re-sync
          if (sourceDataSeries && copiedCount === 0) {
            try {
              const srcCount = sourceDataSeries.count();
              if (srcCount > 0) {
                console.log('[MultiPaneChart] Minimap created with no data, but source has data - triggering re-sync');
                setTimeout(() => {
                  try {
                    const currentCount = sourceDataSeries.count();
                    if (currentCount > 0 && clonedDataSeries.count() === 0) {
                      const nativeX = sourceDataSeries.getNativeXValues();
                      const nativeY = sourceDataSeries.getNativeYValues();
                      if (nativeX && nativeY && nativeX.size() > 0) {
                        const xArr: number[] = [];
                        const yArr: number[] = [];
                        const size = Math.min(nativeX.size(), currentCount);
                        for (let i = 0; i < size; i++) {
                          try {
                            const x = nativeX.get(i);
                            const y = nativeY.get(i);
                            if (isFinite(x) && isFinite(y)) {
                              xArr.push(x);
                              yArr.push(y);
                            }
                          } catch (e) {
                            break;
                          }
                        }
                        if (xArr.length > 0) {
                          minimapSurface.suspendUpdates();
                          try {
                            clonedDataSeries.appendRange(xArr, yArr);
                          } finally {
                            minimapSurface.resumeUpdates();
                          }
                          console.log(`[MultiPaneChart] Re-synced ${xArr.length} data points to minimap`);
                          
                          // Update minimap X-axis to show full range after data sync
                          const newDataRange = clonedDataSeries.getXRange();
                          if (newDataRange) {
                            xAxis.visibleRange = new NumberRange(newDataRange.min, newDataRange.max);
                          }
                        }
                      }
                    }
                  } catch (e) {
                    console.warn('[MultiPaneChart] Error re-syncing minimap data:', e);
                  }
                }, 100);
              }
            } catch (e) {
              // Source may not be ready yet - that's fine, data will arrive later
            }
          }
          
          lastOverviewSourceRef.current = {
            surfaceId: minimapSurface.id,
            minimapSourceSeries: minimapSourceSeriesId
          };
          
          console.log('[MultiPaneChart] Standalone minimap created with', copiedCount, 'points and OverviewRangeSelectionModifier');
          
          // Hide waiting overlay if we have data
          const waitingOverlay = document.getElementById('overview-chart-waiting');
          if (waitingOverlay) {
            waitingOverlay.style.display = copiedCount > 0 ? 'none' : 'flex';
          }
          
        } else {
          // === LEGACY/SINGLE-SURFACE MODE: Use SciChartOverview with shared DataSeries ===
          
          // Determine which surface to use for overview
          let sourceSurface: SciChartSurface | null = null;
          
          if (plotLayout?.minimapSourceSeries) {
            // Dynamic layout with minimap - find the surface that contains the source series
            const sourceSeriesAssignment = plotLayout.layout.series.find(
              s => s.series_id === minimapSourceSeriesId
            );
            if (sourceSeriesAssignment?.pane) {
              const paneSurface = refs.paneSurfaces.get(sourceSeriesAssignment.pane);
              if (paneSurface) {
                sourceSurface = paneSurface.surface;
              }
            }
            
            // Fallback to dataSeriesStore
            if (!sourceSurface && minimapSourceSeriesId) {
              const sourceSeriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
              if (sourceSeriesEntry?.paneId) {
                const paneSurface = refs.paneSurfaces.get(sourceSeriesEntry.paneId);
                if (paneSurface) {
                  sourceSurface = paneSurface.surface;
                }
              }
            }
          }
          
          // Fallback to legacy tickSurface
          if (!sourceSurface && refs.tickSurface) {
            sourceSurface = refs.tickSurface;
          }
          
          if (!sourceSurface) {
            console.warn('[MultiPaneChart] Cannot create overview: no source surface available');
            return;
          }

          // Validate source surface is not deleted
          try {
            // Try to access a property to check if surface is valid
            const _ = sourceSurface.id;
          } catch (e) {
            console.warn('[MultiPaneChart] Cannot create overview: source surface is invalid or deleted');
            return;
          }
          
          // Validate overview container exists
          const overviewContainer = document.getElementById(overviewContainerId);
          if (!overviewContainer) {
            console.warn(`[MultiPaneChart] Cannot create overview: container ${overviewContainerId} not found`);
            return;
          }
          
          // Wait for series to be on surface
          let retries = 0;
          const maxRetries = 10;
          while (retries < maxRetries && sourceSurface.renderableSeries.size() === 0 && !isCancelled) {
            await new Promise(resolve => setTimeout(resolve, 200));
            retries++;
          }
          
          if (isCancelled) return;
          
          if (sourceSurface.renderableSeries.size() === 0) {
            console.log('[MultiPaneChart] Skipping overview creation: source surface has no series');
            return;
          }
          
          // Create/recreate overview if needed
          const currentSourceInfo = {
            surfaceId: sourceSurface?.id,
            minimapSourceSeries: minimapSourceSeriesId
          };
          
          let needsRecreate = false;
          if (refs.overview) {
            const lastSource = lastOverviewSourceRef.current;
            if (lastSource?.minimapSourceSeries !== currentSourceInfo.minimapSourceSeries ||
                lastSource?.surfaceId !== currentSourceInfo.surfaceId) {
              needsRecreate = true;
            }
          }
          
          if (refs.overview && needsRecreate) {
            try {
              refs.overview.delete();
              refs.overview = null;
              lastOverviewSourceRef.current = null;
            } catch (e) {
              console.warn('[MultiPaneChart] Error deleting old overview:', e);
            }
          }
          
          if (!refs.overview) {
            // Additional validation before creating overview
            try {
              // Ensure surface is still valid
              if ((sourceSurface as any).isDeleted) {
                console.warn('[MultiPaneChart] Cannot create overview: source surface is deleted');
                return;
              }
              
              const overview = await SciChartOverview.create(sourceSurface, overviewContainerId, {
                theme: chartTheme,
              });
            
              if (!isCancelled) {
                refs.overview = overview;
                overviewContainerIdRef.current = overviewContainerId;
                lastOverviewSourceRef.current = currentSourceInfo;
                
                // Update waiting overlay
                if (minimapSourceSeriesId) {
                  const sourceSeriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
                  const hasData = sourceSeriesEntry?.dataSeries && sourceSeriesEntry.dataSeries.count() > 0;
                  const waitingOverlay = document.getElementById('overview-chart-waiting');
                  if (waitingOverlay) {
                    waitingOverlay.style.display = hasData ? 'none' : 'flex';
                  }
                }
              } else {
                try {
                  overview.delete();
                } catch (e) {
                  // Ignore cleanup errors
                }
              }
            } catch (overviewError) {
              // Catch overview creation errors specifically to prevent crashes
              console.warn('[MultiPaneChart] Error creating overview (will retry later):', overviewError);
              // Don't throw - allow the function to complete and retry on next effect run
            }
          }
        }
      } catch (e) {
        console.warn('[MultiPaneChart] Failed to create/show overview:', e);
      }
    };

    handleOverview();

    // NO CLEANUP HERE - we only delete on component unmount (see main useEffect cleanup)
  }, [overviewContainerId, isReady, plotLayout, overviewNeedsRefresh, theme]);

  // Separate cleanup effect that only runs on component unmount
  useEffect(() => {
    return () => {
      const refs = chartRefs.current;
      
      // Cleanup standalone minimap surface (for multi_surface layouts)
      if ((refs as any).minimapSurface) {
        try {
          // CRITICAL: Clean up OverviewRangeSelectionModifier FIRST
          const rangeModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
          if (rangeModifier) {
            try {
              rangeModifier.onSelectedAreaChanged = undefined as any;
              const minimapSurf = (refs as any).minimapSurface as SciChartSurface;
              if (minimapSurf?.chartModifiers) {
                minimapSurf.chartModifiers.remove(rangeModifier);
              }
            } catch (e) {}
            (refs as any).minimapRangeSelectionModifier = null;
          }
          
          // Clean up axis subscription
          const axisSubscription = (refs as any).minimapAxisSubscription;
          if (axisSubscription) {
            try {
              axisSubscription.unsubscribe();
            } catch (e) {}
            (refs as any).minimapAxisSubscription = null;
          }
          
          // Now delete the surface
          ((refs as any).minimapSurface as SciChartSurface).delete();
        } catch (e) {
          // Ignore cleanup errors
        }
        (refs as any).minimapSurface = null;
        (refs as any).minimapDataSeries = null;
        (refs as any).minimapSourceSeriesId = null;
        (refs as any).minimapTargetPaneId = null;
        (refs as any).minimapXAxis = null;
      }
      
      // Only delete overview on component unmount (not when toggling)
      // This ensures DataSeries are not deleted while main chart is still using them
      if (refs.overview && refs.tickSurface) {
        // Use async cleanup to properly suspend/resume
        (async () => {
          try {
            isCleaningUpOverviewRef.current = true;
            refs.tickSurface.suspendUpdates();
            if (refs.ohlcSurface) {
              refs.ohlcSurface.suspendUpdates();
            }
            await new Promise(resolve => requestAnimationFrame(resolve));
            await new Promise(resolve => requestAnimationFrame(resolve));
            await new Promise(resolve => setTimeout(resolve, 100));
            if (refs.overview) {
              refs.overview.delete();
              refs.overview = null;
              overviewContainerIdRef.current = null;
              lastOverviewSourceRef.current = null;
            }
            refs.tickSurface.resumeUpdates();
            if (refs.ohlcSurface) {
              refs.ohlcSurface.resumeUpdates();
            }
            isCleaningUpOverviewRef.current = false;
          } catch (e) {
            // Ignore errors during cleanup
            try {
              refs.tickSurface.resumeUpdates();
              if (refs.ohlcSurface) {
                refs.ohlcSurface.resumeUpdates();
              }
            } catch (resumeError) {
              // Ignore resume errors
            }
            isCleaningUpOverviewRef.current = false;
          }
        })();
      }
    };
  }, []); // Empty dependency array = only runs on unmount

  // Track previous registry length to detect when it changes from empty to populated
  const prevRegistryLengthRef = useRef(0);
  
  // Preallocate DataSeries when new series are discovered in registry
  // This ensures buffers are ready before data arrives (proactive preallocation)
  useEffect(() => {
    const refs = chartRefs.current;
    
    // CRITICAL: Track when registry changes from empty to populated
    const registryJustPopulated = prevRegistryLengthRef.current === 0 && registry.length > 0;
    if (registryJustPopulated) {
      console.log(`[MultiPaneChart] 🎯 Registry just populated: ${registry.length} series (was empty)`);
    }
    prevRegistryLengthRef.current = registry.length;
    
    // Preallocation effect - only log warnings for issues
    
    // Check if we have either legacy surfaces OR dynamic panes
    const hasLegacySurfaces = refs.tickSurface && refs.ohlcSurface && refs.tickWasm && refs.ohlcWasm;
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    
    if (!hasLegacySurfaces && !hasDynamicPanes) {
      return;
    }
    if (!registry || registry.length === 0) {
      return;
    }

    // CRITICAL: For dynamic panes, ensure panes are created AND match the current layout
    if (plotLayout) {
      const layoutPanes = new Set(plotLayout.layout.panes.map(p => p.id));
      const existingPanes = new Set(refs.paneSurfaces.keys());
      
      // Check if we have the right number of panes
      if (refs.paneSurfaces.size === 0) {
        return;
      }
      
      // CRITICAL: Check if existing panes match the current layout
      const panesMatch = layoutPanes.size === existingPanes.size && 
        Array.from(layoutPanes).every(paneId => existingPanes.has(paneId));
      
      if (!panesMatch) {
        return;
      }
    }
    if (!isReady) {
      return; // Wait for charts to be initialized
    }
    
    const layoutSeriesIds = plotLayout?.layout?.series?.map(s => s.series_id) || [];
    const registrySeriesIdsArray = registry.map(r => r.id);
    
    // Early return: Check if all series IN THE CURRENT LAYOUT are already preallocated
    // CRITICAL: Only check series that are in the current layout, not all registry series
    // This prevents skipping preallocation when layout changes
    const registrySeriesIds = new Set(registrySeriesIdsArray);
    const preallocatedSeriesIds = new Set(Array.from(refs.dataSeriesStore.keys()).filter(id => {
      const entry = refs.dataSeriesStore.get(id);
      return entry && entry.renderableSeries && entry.paneId; // Fully created series
    }));
    
    // CRITICAL: Filter to only series that are in the CURRENT layout
    // When layout changes, we need to check against the new layout's series, not all registry series
    const chartableSeriesInLayout = registry.filter(regEntry => {
      const seriesInfo = parseSeriesType(regEntry.id);
      if (seriesInfo.chartTarget === 'none') return false; // Skip non-chartable series
      // Only include if it's in the current layout
      if (plotLayout) {
        return layoutSeriesIds.includes(regEntry.id);
      }
      return true; // No layout = include all (legacy mode)
    });
    
    const missingSeries = chartableSeriesInLayout.filter(regEntry => !preallocatedSeriesIds.has(regEntry.id));
    
    if (missingSeries.length === 0 && chartableSeriesInLayout.length > 0) {
      return; // All chartable series already preallocated
    }
    
    const missingCount = missingSeries.length;
    
    const capacity = getSeriesCapacity();
    
    // Count how many series need preallocation
    let newSeriesCount = 0;
    const newSeriesIds: string[] = [];
    for (const regEntry of registry) {
      if (!refs.dataSeriesStore.has(regEntry.id)) {
        newSeriesCount++;
        newSeriesIds.push(regEntry.id);
      }
    }
    
    // Only log if there are new series to preallocate (throttled to avoid spam)
    if (newSeriesCount > 0) {
      const lastPreallocLogTime = (window as any).__lastPreallocLogTime || 0;
      const now = performance.now();
      if (now - lastPreallocLogTime > 2000) { // Log at most once every 2 seconds
      
        (window as any).__lastPreallocLogTime = now;
      }
    }
    
    // Requirement 11.2: Group strategy markers by instrument/strategy/type for consolidation
    // First, collect all strategy marker series IDs
    const strategyMarkerSeriesIds = registry
      .map(reg => reg.id)
      .filter(id => {
        const info = parseSeriesType(id);
        return info.type === 'strategy-marker' || info.type === 'strategy-signal';
      });
    
    // Group strategy markers by instrument/strategy/type
    const markerGroups = groupStrategyMarkers(strategyMarkerSeriesIds);
    
    // Track which series IDs have been processed (to avoid duplicates)
    const processedSeriesIds = new Set<string>();
    
    // Track if any preserved data was restored during this preallocation cycle
    let dataRestoredDuringPreallocation = false;
    
    // Track which specific series had data restored (for per-series axis updates)
    const seriesWithRestoredData = new Set<string>();
    
    registry.forEach(regEntry => {
      const seriesId = regEntry.id;
      
      // Check if series exists but is orphaned (has DataSeries but no renderableSeries or paneId)
      const existingEntry = refs.dataSeriesStore.get(seriesId);
      if (existingEntry) {
        // If series exists but is orphaned (no renderableSeries or paneId), we need to recreate it
        if (!existingEntry.renderableSeries || !existingEntry.paneId) {
        
          // Clear from preallocated set so it can be recreated
          preallocatedSeriesRef.current.delete(seriesId);
          // Don't return - continue to recreate the renderableSeries
        } else {
          // Series is already fully created and assigned to a pane
          return;
        }
      } else if (preallocatedSeriesRef.current.has(seriesId)) {
        // Series is marked as preallocated but doesn't exist in store - clear the flag
        preallocatedSeriesRef.current.delete(seriesId);
        // Continue to create it
      }
      
      const seriesInfo = parseSeriesType(seriesId);
      
      // Requirement 11.2: For strategy markers, use consolidated group key instead of individual series ID
      // This ensures one annotation per group (instrument/strategy/type)
      let effectiveSeriesId = seriesId;
      if ((seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') && plotLayout) {
        // Find the group this series belongs to
        for (const [groupKey, group] of markerGroups) {
          if (group.seriesIds.includes(seriesId)) {
            // Use consolidated series ID for the group
            effectiveSeriesId = getConsolidatedSeriesId(group);
            
            // If we've already processed this group, skip individual series
            if (processedSeriesIds.has(effectiveSeriesId)) {
            
              return;
            }
            
            processedSeriesIds.add(effectiveSeriesId);
      
            break;
          }
        }
      }
      
      // Only preallocate series that should be plotted on charts
      if (seriesInfo.chartTarget === 'none') {
        // Log skipped series for debugging (throttled)
        if (newSeriesIds.includes(seriesId)) {
          console.log(`[MultiPaneChart] ⏭️ Skipping ${seriesId}: chartTarget='none' (strategy markers/signals are rendered as annotations)`);
        }
        return;
      }
      
      // IMPORTANT: Silently skip series not defined in the layout
      // This prevents console errors for server-sent series that user doesn't want to visualize
      if (!isSeriesInLayout(seriesId)) {
        // Series not in layout - log for debugging (only once per series)
        if (newSeriesIds.includes(seriesId) && !warnedSeriesRef.current.has(seriesId)) {
          warnedSeriesRef.current.add(seriesId);
          console.warn(`[MultiPaneChart] ⚠️ Skipping ${seriesId}: not defined in layout. Layout has ${plotLayout?.layout?.series?.length || 0} series defined.`);
        }
        return;
      }
      
      try {
        // Get pane and surface using layout manager or fallback
        const { paneId, surface, wasm } = getPaneForSeries(seriesId);
        
        if (!wasm || !surface || !paneId) {
          // Pane defined in layout but surface not ready yet - this is expected during initialization
          // Only log if we have panes but this specific one is missing
          if (refs.paneSurfaces.size > 0) {
            if (newSeriesIds.includes(seriesId)) {
              console.warn(`[MultiPaneChart] ⚠️ Skipping ${seriesId}: pane "${paneId}" not ready yet (wasm=${!!wasm}, surface=${!!surface}, paneId=${paneId})`);
              // Debug: log available panes
              console.log(`[MultiPaneChart] 🔍 Available panes: ${Array.from(refs.paneSurfaces.keys()).join(', ')}`);
            }
          }
          return;
        }
        
        // Mark as preallocated to prevent duplicate creation
        preallocatedSeriesRef.current.add(seriesId);
        
        // Log when creating new series
        if (newSeriesIds.includes(seriesId)) {
          console.log(`[MultiPaneChart] ✅ Preallocating series: ${seriesId} → pane "${paneId}" (surface has ${surface.renderableSeries.size()} series)`);
        }
        
        // Only log preallocation for new series (not on every registry update)
        // The "Preallocated DataSeries" log below will show when it's actually created
        
        // Get renderable series type from layout or infer from series type
        const renderableSeriesType = getRenderableSeriesType(seriesId);
        
        // CRITICAL: Use sharedWasm for DataSeries to prevent sharing issues
        const dataSeriesWasm = refs.sharedWasm || wasm;
        
        // CRITICAL: First check sharedDataSeriesPool - this persists across layout changes
        // and ensures we NEVER lose data during transitions
        const pooledEntry = sharedDataSeriesPool.get(seriesId);
        
        // Also check refs.dataSeriesStore for legacy orphaned series
        const existingEntry = refs.dataSeriesStore.get(seriesId);
        const shouldReuseDataSeries = existingEntry && existingEntry.dataSeries && (!existingEntry.renderableSeries || !existingEntry.paneId);
        
        // Create DataSeries with preallocated circular buffer (same logic as ensureSeriesExists)
        let dataSeries: XyDataSeries | OhlcDataSeries;
        let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
        
        // PRIORITY ORDER for reusing dataSeries:
        // 1. sharedDataSeriesPool (persists across ALL layout changes - most reliable)
        // 2. existing dataSeriesStore entry (legacy orphaned series)
        // 3. Create new if neither exists
        if (pooledEntry && pooledEntry.dataSeries) {
          // BEST CASE: Reuse from shared pool - this preserves ALL data across layout changes
          dataSeries = pooledEntry.dataSeries;
          console.log(`[MultiPaneChart] ♻️ Reusing dataSeries from pool: ${seriesId} (${dataSeries.count()} points preserved)`);
        } else if (shouldReuseDataSeries && existingEntry.dataSeries) {
          // Fallback: Reuse from legacy store
          dataSeries = existingEntry.dataSeries;
          console.log(`[MultiPaneChart] ♻️ Reusing dataSeries from store: ${seriesId}`);
        } else {
          // Create new DataSeries via the pool (ensures consistency with processChunk)
          const seriesPoolType = (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') ? 'ohlc' : 'xy';
          const newPooledEntry = sharedDataSeriesPool.getOrCreate(seriesId, seriesPoolType);
          if (!newPooledEntry) {
            console.warn(`[MultiPaneChart] ❌ Failed to create dataSeries via pool: ${seriesId}`);
            preallocatedSeriesRef.current.delete(seriesId);
            return;
          }
          dataSeries = newPooledEntry.dataSeries;
          console.log(`[MultiPaneChart] 🆕 Created dataSeries via pool: ${seriesId}`);
          
          // CRITICAL: Restore preserved data from layout change (ONLY for static data feeds)
          // For live data feeds, don't restore - let the live stream populate the series
          // This prevents overwriting live data with stale preserved data
          const isLiveFeed = feedStage === 'live' || feedStage === 'delta';
          const preserved = preservedDataSeriesRef.current.get(seriesId);
          
          // Check if preserved data exists and is valid (not deleted)
          if (!isLiveFeed && preserved && preserved.dataSeries && !(preserved.dataSeries as any).isDeleted) {
            try {
              const preservedCount = preserved.dataSeries.count();
              if (preservedCount > 0) {
                dataRestoredDuringPreallocation = true; // Mark that we restored data
                seriesWithRestoredData.add(seriesId); // Track this specific series
                console.log(`[MultiPaneChart] 🔄 Restoring preserved data for ${seriesId}: ${preservedCount} points (static feed)`);
              
              if (dataSeries instanceof OhlcDataSeries && preserved.dataSeries instanceof OhlcDataSeries) {
                // Restore OHLC data
                const xValues = preserved.dataSeries.getNativeXValues();
                const oValues = preserved.dataSeries.getNativeOpenValues();
                const hValues = preserved.dataSeries.getNativeHighValues();
                const lValues = preserved.dataSeries.getNativeLowValues();
                const cValues = preserved.dataSeries.getNativeCloseValues();
                
                if (xValues && oValues && hValues && lValues && cValues && xValues.size() > 0) {
                  const xArray = new Float64Array(xValues.size());
                  const oArray = new Float64Array(oValues.size());
                  const hArray = new Float64Array(hValues.size());
                  const lArray = new Float64Array(lValues.size());
                  const cArray = new Float64Array(cValues.size());
                  
                  for (let i = 0; i < xValues.size(); i++) {
                    xArray[i] = xValues.get(i);
                    oArray[i] = oValues.get(i);
                    hArray[i] = hValues.get(i);
                    lArray[i] = lValues.get(i);
                    cArray[i] = cValues.get(i);
                  }
                  
                  dataSeries.appendRange(xArray, oArray, hArray, lArray, cArray);
                }
              } else if (dataSeries instanceof XyDataSeries && preserved.dataSeries instanceof XyDataSeries) {
                // Restore XY data
                const xValues = preserved.dataSeries.getNativeXValues();
                const yValues = preserved.dataSeries.getNativeYValues();
                
                if (xValues && yValues && xValues.size() > 0) {
                  const xArray = new Float64Array(xValues.size());
                  const yArray = new Float64Array(yValues.size());
                  
                  for (let i = 0; i < xValues.size(); i++) {
                    xArray[i] = xValues.get(i);
                    yArray[i] = yValues.get(i);
                  }
                  
                  dataSeries.appendRange(xArray, yArray);
                }
              }
              
              // Remove from preserved map after restoring
              preservedDataSeriesRef.current.delete(seriesId);
              
              // CRITICAL: After restoring data, force axis updates to ensure data is visible
              // This is especially important for static data feeds where data won't trigger updates
              setTimeout(() => {
                try {
                  if (surface && paneId) {
                    surface.invalidateElement();
                    // Force X-axis range update to show the restored data
                    const xAxis = surface.xAxes.get(0);
                    if (xAxis && dataSeries.count() > 0) {
                      const currentRange = xAxis.visibleRange;
                      if (currentRange) {
                        // Trigger range update by setting it to itself
                        xAxis.visibleRange = currentRange;
                      }
                    }
                    // Force Y-axis range update
                    const yAxis = surface.yAxes.get(0);
                    if (yAxis) {
                      const yRange = yAxis.visibleRange;
                      if (yRange) {
                        yAxis.visibleRange = yRange;
                      }
                    }
                  }
                } catch (axisError) {
                  // Ignore axis update errors
                }
              }, 50);
              } else {
                // No data to restore, remove from map
                preservedDataSeriesRef.current.delete(seriesId);
              }
            } catch (restoreError) {
              console.warn(`[MultiPaneChart] Failed to restore preserved data for ${seriesId}:`, restoreError);
              preservedDataSeriesRef.current.delete(seriesId);
            }
          }
        }
        
        // CRITICAL: After restoring data, ensure the DataSeries has data before creating renderableSeries
        // This ensures the series is visible immediately after restoration
        const hasDataAfterRestore = dataSeries.count() > 0;
        if (hasDataAfterRestore && dataRestoredDuringPreallocation) {
          console.log(`[MultiPaneChart] ✅ DataSeries ${seriesId} has ${dataSeries.count()} points after restoration`);
        }
        
        // Create renderableSeries (always create new, even if reusing DataSeries)
        if (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') {
          renderableSeries = new FastCandlestickRenderableSeries(wasm, {
            dataSeries: dataSeries as OhlcDataSeries,
            strokeUp: '#26a69a',
            brushUp: '#26a69a88',
            strokeDown: '#ef5350',
            brushDown: '#ef535088',
            strokeThickness: 1,
          });
        } else {
          // Get series assignment from layout for styling
          const seriesAssignment = plotLayout?.layout.series.find(s => s.series_id === seriesId);
          
          // Determine stroke color based on type or layout style
          let stroke = seriesAssignment?.style?.stroke; // Use layout style if provided
          if (!stroke) {
            // Fallback to default colors based on type
            stroke = '#50C7E0'; // Default tick color
            if (seriesInfo.isIndicator) {
              stroke = '#F48420'; // Orange for indicators
            } else if (seriesInfo.type === 'strategy-pnl') {
              stroke = '#4CAF50'; // Green for PnL
            } else if (seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') {
              stroke = '#FF9800'; // Orange for markers/signals
            }
          }
          
          // Get stroke thickness from layout or use default
          const strokeThickness = seriesAssignment?.style?.strokeThickness ?? 1;
          
          // Get fill color for mountain series from layout or use default
          const fill = seriesAssignment?.style?.fill ?? (stroke + '44'); // Add transparency for fill
          
          // Create point marker if configured in layout
          let pointMarker: EllipsePointMarker | undefined;
          const pmConfig = seriesAssignment?.style?.pointMarker;
          if (pmConfig) {
            // Support both boolean (true) and object configuration
            const isEnabled = pmConfig === true || (typeof pmConfig === 'object' && pmConfig.enabled);
            if (isEnabled) {
              const pmSize = (typeof pmConfig === 'object' && pmConfig.size) ? pmConfig.size : 5;
              const pmFill = (typeof pmConfig === 'object' && pmConfig.color) ? pmConfig.color : stroke;
              const pmStroke = (typeof pmConfig === 'object' && pmConfig.strokeColor) ? pmConfig.strokeColor : stroke;
              pointMarker = new EllipsePointMarker(wasm, {
                width: pmSize,
                height: pmSize,
                fill: pmFill,
                stroke: pmStroke,
                strokeThickness: 1,
              });
            }
          }
          
          if (renderableSeriesType === 'FastMountainRenderableSeries') {
            renderableSeries = new FastMountainRenderableSeries(wasm, {
              dataSeries: dataSeries as XyDataSeries,
              stroke: stroke,
              fill: fill,
              strokeThickness: strokeThickness,
              pointMarker: pointMarker,
              resamplingMode: getResamplingMode(),
              resamplingPrecision: getResamplingPrecision(),
            });
          } else {
            // Default to FastLineRenderableSeries
            renderableSeries = new FastLineRenderableSeries(wasm, {
              dataSeries: dataSeries as XyDataSeries,
              stroke: stroke,
              strokeThickness: strokeThickness,
              pointMarker: pointMarker,
              resamplingMode: getResamplingMode(),
              resamplingPrecision: getResamplingPrecision(),
            });
          }
        }
        
        // Add to store - use effectiveSeriesId for consolidated markers
        const storeKey = effectiveSeriesId !== seriesId ? effectiveSeriesId : seriesId;
        
        // For consolidated markers, check if we already have a consolidated entry
        // If so, we need to merge data instead of creating a new entry
        if (effectiveSeriesId !== seriesId) {
          const existingConsolidated = refs.dataSeriesStore.get(storeKey);
          if (existingConsolidated && existingConsolidated.dataSeries) {
            // Merge data from this series into the consolidated DataSeries
            try {
              if (dataSeries.count() > 0) {
                const xValues = dataSeries.getNativeXValues();
                const yValues = dataSeries.getNativeYValues();
                if (xValues && yValues && xValues.size() > 0) {
                  const xArray = new Float64Array(xValues.size());
                  const yArray = new Float64Array(yValues.size());
                  for (let i = 0; i < xValues.size(); i++) {
                    xArray[i] = xValues.get(i);
                    yArray[i] = yValues.get(i);
                  }
                  (existingConsolidated.dataSeries as XyDataSeries).appendRange(xArray, yArray);
                 
                }
              }
              // Don't create a new entry - use the existing consolidated one
              return;
            } catch (mergeError) {
              console.warn(`[MultiPaneChart] Failed to merge ${seriesId} into consolidated group ${storeKey}:`, mergeError);
              // Fall through to create new entry if merge fails
            }
          }
        }
        
        refs.dataSeriesStore.set(storeKey, {
          dataSeries,
          renderableSeries,
          chartTarget: seriesInfo.chartTarget, // Keep for backward compatibility
          paneId: paneId, // New: pane-based routing
          seriesType: seriesInfo.type,
          renderableSeriesType: renderableSeriesType, // Store the type from layout
        });
        
        // Add to appropriate chart surface
        try {
          surface.renderableSeries.add(renderableSeries);
          const dataCount = dataSeries.count();
          if (newSeriesIds.includes(seriesId)) {
            console.log(`[MultiPaneChart] ✅ Series ${seriesId} added to surface "${paneId}", renderableSeries count: ${surface.renderableSeries.size()}, visible: ${renderableSeries.isVisible}, data points: ${dataCount}`);
          }
          
          // CRITICAL: If data was restored for this specific series, mark it for axis update
          // We'll update axes after all series are added (in the delayed refresh)
          // This ensures we calculate ranges from all series in the pane, not just one
          if (dataCount > 0 && seriesWithRestoredData.has(seriesId)) {
            console.log(`[MultiPaneChart] ✅ Series ${seriesId} has ${dataCount} restored data points, will update axes after all series added`);
          }
          
          // Invalidate surface to trigger redraw
          surface.invalidateElement();
        } catch (addError) {
          console.error(`[MultiPaneChart] ❌ Failed to add ${seriesId} to surface "${paneId}":`, addError);
          // Remove from store if we failed to add to surface
          refs.dataSeriesStore.delete(storeKey);
          preallocatedSeriesRef.current.delete(seriesId);
          return;
        }
        
        // Set initial visibility based on visibleSeries prop
        // CRITICAL: If series is in layout, make it visible by default (even if not in visibleSeries yet)
        // This ensures series show up when layout is loaded before data arrives
        // For consolidated markers, check visibility of any series in the group
        const isInLayout = plotLayout?.layout.series.some(s => {
          if (effectiveSeriesId !== seriesId) {
            // For consolidated markers, check if any series in the group is in layout
            const group = Array.from(markerGroups.values()).find(g => g.groupKey === effectiveSeriesId.split(':strategy:')[0] + ':strategy:' + effectiveSeriesId.split(':strategy:')[1]);
            return group ? group.seriesIds.some(id => plotLayout.layout.series.some(s => s.series_id === id)) : false;
          }
          return s.series_id === seriesId;
        });
        
        // Check visibility - for consolidated markers, visible if any series in group is visible
        let shouldBeVisible = false;
        if (visibleSeries) {
          if (effectiveSeriesId !== seriesId) {
            // Check if any series in the consolidated group is visible
            const group = Array.from(markerGroups.values()).find(g => {
              const consolidatedId = getConsolidatedSeriesId(g);
              return consolidatedId === effectiveSeriesId;
            });
            shouldBeVisible = group ? group.seriesIds.some(id => visibleSeries.has(id)) : visibleSeries.has(seriesId);
          } else {
            shouldBeVisible = visibleSeries.has(seriesId);
          }
          renderableSeries.isVisible = shouldBeVisible || isInLayout;
        } else {
          // If no visibleSeries set, default to visible if in layout
          renderableSeries.isVisible = isInLayout !== false; // Default to true if in layout, or true if no layout
        }
        
        const logSeriesId = effectiveSeriesId !== seriesId ? `${seriesId} (consolidated as ${effectiveSeriesId})` : seriesId;
       
        
        // Requirement 0.4: Strategy markers must appear on all eligible panes (except PnL and bar plots)
        // Requirement 11.2: Use consolidated series ID for duplication
        // Create separate DataSeries and RenderableSeries for each eligible pane to avoid DataSeries sharing
        if ((seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') && plotLayout) {
          const eligiblePanes = Array.from(plotLayout.strategyMarkerPanes);
          
          for (const eligiblePaneId of eligiblePanes) {
            // Skip if this is the primary pane (already created above)
            if (eligiblePaneId === paneId) continue;
            
            // Get the pane surface
            const eligiblePaneSurface = refs.paneSurfaces.get(eligiblePaneId);
            if (!eligiblePaneSurface) {
              console.warn(`[MultiPaneChart] Cannot duplicate strategy marker ${seriesId} to pane ${eligiblePaneId}: pane not found`);
              continue;
            }
            
            try {
              // Create a separate DataSeries for this pane (to avoid sharing issues)
              // Use consolidated series ID for naming
              const duplicateDataSeries = new XyDataSeries(dataSeriesWasm, {
                dataSeriesName: `${effectiveSeriesId}:${eligiblePaneId}`, // Unique name per pane (using consolidated ID)
                fifoCapacity: capacity,
                capacity: capacity,
                containsNaN: false,
                dataIsSortedInX: true,
                dataEvenlySpacedInX: false,
              });
              
              // Copy existing data from primary DataSeries to duplicate
              // This ensures the duplicate starts with the same data
              if (dataSeries.count() > 0) {
                try {
                  const xValues = dataSeries.getNativeXValues();
                  const yValues = dataSeries.getNativeYValues();
                  if (xValues && yValues && xValues.size() > 0) {
                    // Convert SCRTDoubleVector to Float64Array
                    const xArray = new Float64Array(xValues.size());
                    const yArray = new Float64Array(yValues.size());
                    for (let i = 0; i < xValues.size(); i++) {
                      xArray[i] = xValues.get(i);
                      yArray[i] = yValues.get(i);
                    }
                    duplicateDataSeries.appendRange(xArray, yArray);
                  }
                } catch (copyError) {
                  console.warn(`[MultiPaneChart] Failed to copy existing data for strategy marker duplicate:`, copyError);
                  // Continue anyway - data will be synced when new data arrives
                }
              }
              
              // Get style from layout if available
              const seriesAssignment = plotLayout?.layout.series.find(s => s.series_id === seriesId);
              const markerStroke = seriesAssignment?.style?.stroke ?? '#FF9800';
              const markerStrokeThickness = seriesAssignment?.style?.strokeThickness ?? 1;
              
              // Create renderable series for this pane
              const duplicateRenderableSeries = new FastLineRenderableSeries(eligiblePaneSurface.wasm, {
                dataSeries: duplicateDataSeries,
                stroke: markerStroke,
                strokeThickness: markerStrokeThickness,
                pointMarker: undefined,
                resamplingMode: getResamplingMode(),
                resamplingPrecision: getResamplingPrecision(),
              });
              
              // Set visibility to match primary series
              duplicateRenderableSeries.isVisible = renderableSeries.isVisible;
              
              // Add to pane surface
              eligiblePaneSurface.surface.renderableSeries.add(duplicateRenderableSeries);
              
              // Store with unique key to track duplicates (use consolidated ID)
              const duplicateKey = `${effectiveSeriesId}:${eligiblePaneId}`;
              refs.dataSeriesStore.set(duplicateKey, {
                dataSeries: duplicateDataSeries,
                renderableSeries: duplicateRenderableSeries,
                chartTarget: seriesInfo.chartTarget,
                paneId: eligiblePaneId,
                seriesType: seriesInfo.type,
                renderableSeriesType: 'FastLineRenderableSeries',
              });
              
            
            } catch (duplicateError) {
              console.warn(`[MultiPaneChart] Failed to duplicate strategy marker ${seriesId} to pane ${eligiblePaneId}:`, duplicateError);
            }
          }
        }
      } catch (e) {
        console.error(`[MultiPaneChart] ❌ Failed to preallocate DataSeries for ${seriesId}:`, e);
        // Remove from preallocated set on error
        preallocatedSeriesRef.current.delete(seriesId);
        // Remove from store if it was partially created
        refs.dataSeriesStore.delete(seriesId);
      }
    });
    
    // Invalidate surfaces to ensure new series are rendered
    // CRITICAL: Only invalidate if we actually created new series to prevent unnecessary rerenders
    if (newSeriesCount > 0) {
      console.log(`[MultiPaneChart] 🎨 Invalidating ${newSeriesCount} surfaces after creating new series`);
      
      if (refs.tickSurface) {
        refs.tickSurface.invalidateElement();
      }
      if (refs.ohlcSurface) {
        refs.ohlcSurface.invalidateElement();
      }
      // Invalidate all dynamic panes and force axis updates
      for (const [paneId, paneSurface] of refs.paneSurfaces) {
        try {
          paneSurface.surface.invalidateElement();
          // Force axis updates to ensure ranges are set
          if (paneSurface.xAxis) {
            const xRange = paneSurface.xAxis.visibleRange;
            if (xRange) {
              paneSurface.xAxis.visibleRange = xRange;
            }
          }
          if (paneSurface.yAxis) {
            const yRange = paneSurface.yAxis.visibleRange;
            if (yRange) {
              paneSurface.yAxis.visibleRange = yRange;
            }
          }
        } catch (e) {
          console.warn(`[MultiPaneChart] Error invalidating pane ${paneId}:`, e);
        }
      }
      
      // CRITICAL: If data was restored from layout change, force a delayed refresh
      // This ensures axes update to show the restored data (especially for static data feeds)
      // Also check if we have any preserved data that wasn't restored (shouldn't happen, but safety check)
      // ALSO: When session is COMPLETE, we must force an axis refresh after layout change,
      // because no new data will arrive to trigger auto-ranging.
      const hasPreservedData = preservedDataSeriesRef.current.size > 0;
      const isSessionComplete = feedStage === 'complete';
      const shouldRefresh = dataRestoredDuringPreallocation || hasPreservedData || isSessionComplete;
      
      if (shouldRefresh) {
        // Use a longer delay to ensure data is fully processed and series are attached
        setTimeout(() => {
          if (dataRestoredDuringPreallocation) {
            console.log(`[MultiPaneChart] 🔄 Forcing delayed refresh after data restoration (${newSeriesCount} series created, ${preservedDataSeriesRef.current.size} still preserved)`);
          } else if (hasPreservedData) {
            console.log(`[MultiPaneChart] ⚠️ Forcing delayed refresh - preserved data exists but wasn't restored (${preservedDataSeriesRef.current.size} series)`);
          }
          
          // CRITICAL: Manually calculate X-axis range from all series in each pane
          // This is more reliable than zoomExtents() which might not work correctly after data restoration
          // We'll do this in two passes: first pass sets the range, second pass ensures it's applied
          for (const [paneId, paneSurface] of refs.paneSurfaces) {
            try {
              // Find all series in this pane and calculate data range
              let dataMin: number | null = null;
              let dataMax: number | null = null;
              let hasData = false;
              
              for (const [seriesId, entry] of refs.dataSeriesStore) {
                if (entry.paneId === paneId && entry.dataSeries && entry.dataSeries.count() > 0) {
                  hasData = true;
                  try {
                    const xRange = entry.dataSeries.getXRange();
                    if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
                      if (dataMin === null || xRange.min < dataMin) {
                        dataMin = xRange.min;
                      }
                      if (dataMax === null || xRange.max > dataMax) {
                        dataMax = xRange.max;
                      }
                    }
                  } catch (e) {
                    // Continue with other series
                  }
                }
              }
              
              if (hasData && dataMin !== null && dataMax !== null && paneSurface.xAxis) {
                const defaultRange = plotLayout?.xAxisDefaultRange;
                let newXRange: NumberRange;
                
                if (defaultRange?.mode === 'lastMinutes' && defaultRange.value) {
                  // Show last N minutes
                  const windowMs = defaultRange.value * 60 * 1000;
                  const padding = 10 * 1000;
                  newXRange = new NumberRange(dataMax - windowMs, dataMax + padding);
                  console.log(`[MultiPaneChart] 📊 Setting X-axis range for ${paneId}: last ${defaultRange.value} minutes (${dataMax - windowMs} to ${dataMax + padding})`);
                } else if (defaultRange?.mode === 'session') {
                  // Show entire session with padding
                  const padding = (dataMax - dataMin) * 0.02; // 2% padding
                  newXRange = new NumberRange(dataMin - padding, dataMax + padding);
                  console.log(`[MultiPaneChart] 📊 Setting X-axis range for ${paneId}: session (${dataMin - padding} to ${dataMax + padding})`);
                } else {
                  // Default: show all data with padding
                  const padding = (dataMax - dataMin) * 0.02; // 2% padding
                  newXRange = new NumberRange(dataMin - padding, dataMax + padding);
                  console.log(`[MultiPaneChart] 📊 Setting X-axis range for ${paneId}: all data (${dataMin - padding} to ${dataMax + padding})`);
                }
                
                // Set X-axis range and auto-scale Y-axis (unless user manually stretched)
                paneSurface.surface.suspendUpdates();
                try {
                  paneSurface.xAxis.visibleRange = newXRange;
                  // Auto-scale Y-axis based on data AND hlines (skip if user manually stretched)
                  if (!yAxisManuallyStretchedRef.current) {
                    zoomExtentsYWithHLines(paneSurface.surface, paneId);
                  }
                } finally {
                  paneSurface.surface.resumeUpdates();
                }
                
                // Force invalidation to ensure the change is visible
                paneSurface.surface.invalidateElement();
              } else if (hasData) {
                console.warn(`[MultiPaneChart] ⚠️ Pane ${paneId} has data but couldn't calculate range (min: ${dataMin}, max: ${dataMax})`);
              }
              
              // Always invalidate to trigger redraw
              paneSurface.surface.invalidateElement();
            } catch (e) {
              console.warn(`[MultiPaneChart] Error refreshing pane ${paneId} after data restoration:`, e);
            }
          }
          
          // CRITICAL: Second pass - use requestAnimationFrame to ensure axis updates are applied
          // This ensures the axis range is set after the surface has fully processed the data
          requestAnimationFrame(() => {
            for (const [paneId, paneSurface] of refs.paneSurfaces) {
              try {
                // Check if pane has data and axis exists
                let hasData = false;
                for (const [seriesId, entry] of refs.dataSeriesStore) {
                  if (entry.paneId === paneId && entry.dataSeries && entry.dataSeries.count() > 0) {
                    hasData = true;
                    break;
                  }
                }
                
                if (hasData && paneSurface.xAxis) {
                  // Force a refresh by calling zoomExtents() which will recalculate from all series
                  // This is a fallback to ensure the axis is correctly positioned
                  try {
                    paneSurface.surface.zoomExtents();
                    console.log(`[MultiPaneChart] 📊 Second pass: Called zoomExtents() for ${paneId}`);
                    paneSurface.surface.invalidateElement();
                  } catch (e) {
                    console.warn(`[MultiPaneChart] Failed to call zoomExtents() for ${paneId}:`, e);
                  }
                }
              } catch (e) {
                console.warn(`[MultiPaneChart] Error in second pass for ${paneId}:`, e);
              }
            }
          });
          
          // CRITICAL: If there's still preserved data that wasn't restored, try to restore it now
          // This is a safety net for cases where restoration failed during preallocation
          if (preservedDataSeriesRef.current.size > 0) {
            console.log(`[MultiPaneChart] ⚠️ Attempting to restore ${preservedDataSeriesRef.current.size} remaining preserved series`);
            const refs = chartRefs.current;
            for (const [preservedSeriesId, preserved] of preservedDataSeriesRef.current.entries()) {
              try {
                const entry = refs.dataSeriesStore.get(preservedSeriesId);
                if (entry && entry.dataSeries && entry.dataSeries.count() === 0) {
                  // Series exists but has no data - restore it
                  const preservedCount = preserved.dataSeries.count();
                  if (preservedCount > 0 && !(preserved.dataSeries as any).isDeleted) {
                    console.log(`[MultiPaneChart] 🔄 Late restoration for ${preservedSeriesId}: ${preservedCount} points`);
                    
                    if (entry.dataSeries instanceof OhlcDataSeries && preserved.dataSeries instanceof OhlcDataSeries) {
                      const xValues = preserved.dataSeries.getNativeXValues();
                      const oValues = preserved.dataSeries.getNativeOpenValues();
                      const hValues = preserved.dataSeries.getNativeHighValues();
                      const lValues = preserved.dataSeries.getNativeLowValues();
                      const cValues = preserved.dataSeries.getNativeCloseValues();
                      
                      if (xValues && oValues && hValues && lValues && cValues && xValues.size() > 0) {
                        const xArray = new Float64Array(xValues.size());
                        const oArray = new Float64Array(oValues.size());
                        const hArray = new Float64Array(hValues.size());
                        const lArray = new Float64Array(lValues.size());
                        const cArray = new Float64Array(cValues.size());
                        
                        for (let i = 0; i < xValues.size(); i++) {
                          xArray[i] = xValues.get(i);
                          oArray[i] = oValues.get(i);
                          hArray[i] = hValues.get(i);
                          lArray[i] = lValues.get(i);
                          cArray[i] = cValues.get(i);
                        }
                        
                        entry.dataSeries.appendRange(xArray, oArray, hArray, lArray, cArray);
                      }
                    } else if (entry.dataSeries instanceof XyDataSeries && preserved.dataSeries instanceof XyDataSeries) {
                      const xValues = preserved.dataSeries.getNativeXValues();
                      const yValues = preserved.dataSeries.getNativeYValues();
                      
                      if (xValues && yValues && xValues.size() > 0) {
                        const xArray = new Float64Array(xValues.size());
                        const yArray = new Float64Array(yValues.size());
                        
                        for (let i = 0; i < xValues.size(); i++) {
                          xArray[i] = xValues.get(i);
                          yArray[i] = yValues.get(i);
                        }
                        
                        entry.dataSeries.appendRange(xArray, yArray);
                      }
                    }
                    
                    // Invalidate the surface for this series
                    if (entry.paneId) {
                      const paneSurface = refs.paneSurfaces.get(entry.paneId);
                      if (paneSurface) {
                        paneSurface.surface.invalidateElement();
                      }
                    }
                    
                    preservedDataSeriesRef.current.delete(preservedSeriesId);
                  }
                }
              } catch (lateRestoreError) {
                console.warn(`[MultiPaneChart] Failed late restoration for ${preservedSeriesId}:`, lateRestoreError);
                preservedDataSeriesRef.current.delete(preservedSeriesId);
              }
            }
          }
        }, 300);
      }
      
      // CRITICAL: After creating new series, trigger reprocessing of buffered samples
      // This ensures data that arrived before series were created gets plotted
      // Use a small delay to ensure series are fully initialized
      setTimeout(() => {
        const refs = chartRefs.current;
        const bufferedCount = sampleBufferRef.current.length + processingQueueRef.current.length;
        const skippedCount = skippedSamplesBufferRef.current.length;
        
        // Reprocess skipped samples that were buffered because series didn't exist
        if (skippedCount > 0) {
          console.log(`[MultiPaneChart] 🔄 Reprocessing ${skippedCount} skipped samples after creating ${newSeriesCount} new series`);
          // Add skipped samples back to the processing queue
          processingQueueRef.current = processingQueueRef.current.concat(skippedSamplesBufferRef.current);
          skippedSamplesBufferRef.current = []; // Clear the buffer
        }
        
        // Also process any samples still in the main buffer
        // CRITICAL: Always process if we have buffered or skipped samples
        // This is especially important for static data feeds (ui-feed.exe) where all data
        // arrives at once before the chart is ready
        if (bufferedCount > 0 || skippedCount > 0) {
          console.log(`[MultiPaneChart] 🔄 Processing ${bufferedCount + skippedCount} buffered samples after creating ${newSeriesCount} new series`);
          processBatchedSamples();
        }
        
        // CRITICAL: After reprocessing, explicitly invalidate all surfaces to force a refresh
        // This ensures data appears on full reload (not just hot reload)
        // For static data feeds (like ui-feed.exe), this is especially important
        setTimeout(() => {
          const refs = chartRefs.current;
          const stillBuffered = sampleBufferRef.current.length + processingQueueRef.current.length;
          const stillSkipped = skippedSamplesBufferRef.current.length;
          
          console.log(`[MultiPaneChart] 🔄 Forcing surface refresh after data reprocessing (buffered: ${stillBuffered}, skipped: ${stillSkipped})`);
          
          // Check if any series have data
          let hasDataInSeries = false;
          for (const [, entry] of refs.dataSeriesStore) {
            if (entry.dataSeries && entry.dataSeries.count() > 0) {
              hasDataInSeries = true;
              break;
            }
          }
          
          if (hasDataInSeries || stillBuffered > 0 || stillSkipped > 0) {
            // Invalidate all surfaces to force a visual refresh
            if (refs.tickSurface) {
              refs.tickSurface.invalidateElement();
            }
            if (refs.ohlcSurface) {
              refs.ohlcSurface.invalidateElement();
            }
            // Invalidate all dynamic panes
            for (const [paneId, paneSurface] of refs.paneSurfaces) {
              try {
                paneSurface.surface.invalidateElement();
                // Force X-axis to update by triggering a range change
                if (paneSurface.xAxis) {
                  const currentRange = paneSurface.xAxis.visibleRange;
                  if (currentRange) {
                    // Trigger range update by setting it to itself
                    paneSurface.xAxis.visibleRange = currentRange;
                  }
                }
                // Force Y-axis update
                if (paneSurface.yAxis) {
                  const yRange = paneSurface.yAxis.visibleRange;
                  if (yRange) {
                    paneSurface.yAxis.visibleRange = yRange;
                  }
                }
              } catch (e) {
                // Ignore errors during invalidation
              }
            }
            
            // If there's still buffered data, process it again
            if (stillBuffered > 0 || stillSkipped > 0) {
              console.log(`[MultiPaneChart] 🔄 Still have buffered data, processing again...`);
              setTimeout(() => {
                processBatchedSamples();
              }, 100);
            }
          }
        }, 200); // Give processing time to complete
        
        // CRITICAL: For static data feeds (ui-feed.exe), add an additional check after a longer delay
        // This ensures all data that arrived before chart was ready gets processed
        setTimeout(() => {
          const refs = chartRefs.current;
          const finalBuffered = sampleBufferRef.current.length + processingQueueRef.current.length;
          const finalSkipped = skippedSamplesBufferRef.current.length;
          let hasAnyData = false;
          
          // Check if any series have data
          for (const [, entry] of refs.dataSeriesStore) {
            if (entry.dataSeries && entry.dataSeries.count() > 0) {
              hasAnyData = true;
              break;
            }
          }
          
          if (finalBuffered > 0 || finalSkipped > 0) {
            console.log(`[MultiPaneChart] 🔄 Final check: Processing remaining ${finalBuffered + finalSkipped} buffered samples`);
            if (finalSkipped > 0) {
              processingQueueRef.current = processingQueueRef.current.concat(skippedSamplesBufferRef.current);
              skippedSamplesBufferRef.current = [];
            }
            processBatchedSamples();
            
            // Force one final refresh
            setTimeout(() => {
              for (const [paneId, paneSurface] of refs.paneSurfaces) {
                try {
                  paneSurface.surface.invalidateElement();
                } catch (e) {
                  // Ignore errors
                }
              }
            }, 200);
          } else if (!hasAnyData && registry.length > 0 && refs.dataSeriesStore.size > 0) {
            // No buffered data but also no data in series - this shouldn't happen
            // Force a refresh anyway to ensure chart displays
            console.log(`[MultiPaneChart] ⚠️ No data in series despite registry and series existing, forcing refresh`);
            for (const [paneId, paneSurface] of refs.paneSurfaces) {
              try {
                paneSurface.surface.invalidateElement();
              } catch (e) {
                // Ignore errors
              }
            }
          }
        }, 1000); // Wait 1 second to ensure all data has been received and buffered
      }, 100);
      
      // If overview exists, check if it needs to be recreated because series were just added
      // This handles the case where overview was created before series were added to the new surface
      if (refs.overview && plotLayout?.minimapSourceSeries && newSeriesCount > 0) {
        const minimapSourceSeriesId = plotLayout.minimapSourceSeries;
        
        // Find the correct source surface from layout
        const sourceSeriesAssignment = plotLayout.layout.series.find(
          s => s.series_id === minimapSourceSeriesId
        );
        let correctPaneSurface: PaneSurface | null = null;
        
        if (sourceSeriesAssignment?.pane) {
          correctPaneSurface = refs.paneSurfaces.get(sourceSeriesAssignment.pane) || null;
        } else {
          // Fallback to dataSeriesStore
          const sourceSeriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
          if (sourceSeriesEntry?.paneId) {
            correctPaneSurface = refs.paneSurfaces.get(sourceSeriesEntry.paneId) || null;
          }
        }
        
        if (correctPaneSurface && correctPaneSurface.surface.renderableSeries.size() > 0) {
          // Check if overview is pointing to the correct surface
          try {
            const overviewSurface = (refs.overview as any).sciChartSurface;
            const currentSourceSurface = (overviewSurface as any)?._sourceSurface || 
                                        (overviewSurface as any)?.parentSurface;
            
            // If overview is pointing to wrong surface, or if it's pointing to correct surface but empty, recreate
            const isWrongSurface = currentSourceSurface !== correctPaneSurface.surface;
            const hasNoSeries = overviewSurface?.renderableSeries?.size() === 0;
            
            if (isWrongSurface || hasNoSeries) {
              console.log('[MultiPaneChart] Overview needs recreation after series added:', {
                isWrongSurface,
                hasNoSeries,
                correctSurfaceId: correctPaneSurface.surface?.id,
                currentSourceId: currentSourceSurface?.id,
                seriesCount: correctPaneSurface.surface.renderableSeries.size()
              });
              
              // Delete and recreate overview with proper suspension
              // Use Promise chain since we're in a useEffect (not async)
              const deleteOverviewSafely = async () => {
                try {
                  // CRITICAL: Suspend updates to prevent render loop errors
                  for (const pane of refs.paneSurfaces.values()) {
                    try { pane.surface.suspendUpdates(); } catch (e) { /* ignore */ }
                  }
                  await new Promise(resolve => requestAnimationFrame(resolve));
                  
                  if (refs.overview) {
                    refs.overview.delete();
                    refs.overview = null;
                    lastOverviewSourceRef.current = null;
                  }
                  
                  // Resume updates
                  for (const pane of refs.paneSurfaces.values()) {
                    try { pane.surface.resumeUpdates(); } catch (e) { /* ignore */ }
                  }
                  
                  // Trigger overview recreation by incrementing refresh counter
                  setOverviewNeedsRefresh(prev => prev + 1);
                } catch (e) {
                  console.warn('[MultiPaneChart] Error deleting overview for recreation:', e);
                  // Try to resume on error
                  for (const pane of refs.paneSurfaces.values()) {
                    try { pane.surface.resumeUpdates(); } catch (resumeErr) { /* ignore */ }
                  }
                }
              };
              deleteOverviewSafely();
            } else {
              // Just refresh the overview
              overviewSurface.invalidateElement();
            }
          } catch (e) {
            console.warn('[MultiPaneChart] Error checking overview state:', e);
          }
        }
      }
    }
  }, [registry, visibleSeries, isReady, plotLayout, panesReadyCount]); // Added panesReadyCount to trigger when panes are created

  // Track if dynamic panes have been initialized to prevent re-initialization
  const dynamicPanesInitializedRef = useRef<boolean>(false);
  const currentLayoutIdRef = useRef<string | null>(null);
  const parentSurfaceReadyRef = useRef<boolean>(false);
  const pendingPaneCreationRef = useRef<boolean>(false);
  const cleanupInProgressRef = useRef<boolean>(false);

  // Callback to handle grid container being ready (called by DynamicPlotGrid)
  const handleGridReady = useCallback(async (parentContainerId: string, rows: number, cols: number) => {
    const refs = chartRefs.current;
    // Use ref to get latest plotLayout (avoid stale closure)
    const currentLayout = plotLayoutRef.current;

    if (parentSurfaceReadyRef.current) {
      console.log('[MultiPaneChart] Grid ready callback skipped: already ready');
      return; // Already initialized
    }
    
    if (!currentLayout) {
      console.log('[MultiPaneChart] Grid ready callback skipped: no layout yet');
      return; // No layout
    }

    try {
      // Initialize WASM if not already done
      if (!refs.sharedWasm) {
        console.log('[MultiPaneChart] Initializing WASM from handleGridReady');
        SciChartSurface.useWasmFromCDN();

        // Disable DPI scaling for better performance
        DpiHelper.IsDpiScaleEnabled = false;

        // Enable performance optimizations
        SciChartDefaults.useNativeText = true;
        SciChartDefaults.useSharedCache = true;

        // Wait for WASM to be fully loaded
        console.log('[MultiPaneChart] Waiting for WASM to load...');
        await new Promise(resolve => setTimeout(resolve, 100));
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));

        console.log('[MultiPaneChart] WASM loaded successfully');
      }

      // Initialize pane manager if not already created
      if (!paneManagerRef.current) {
        console.log('[MultiPaneChart] Creating pane manager for grid initialization');
        paneManagerRef.current = new DynamicPaneManager(chartTheme, config.chart.timezone || 'UTC');
      }
      const paneManager = paneManagerRef.current;

      console.log('[MultiPaneChart] Initializing parent surface:', parentContainerId, `grid: ${rows}x${cols}`);
      await paneManager.initializeParentSurface(parentContainerId, rows, cols);
      
      // Now get the WASM context AFTER parent surface is initialized
      if (!refs.sharedWasm) {
        refs.sharedWasm = paneManager.getWasmContext();
        
        // CRITICAL: ALWAYS call initialize with the new WASM context
        // The pool's initialize() handles migration of existing data when context changes
        // This is essential for preserving data across layout changes (when parent surface is recreated)
        if (refs.sharedWasm) {
          const capacity = getSeriesCapacity();
          sharedDataSeriesPool.initialize(refs.sharedWasm, {
            xyCapacity: capacity,
            ohlcCapacity: Math.floor(capacity / 4), // OHLC typically needs less capacity
            fifoEnabled: config.performance?.fifoEnabled ?? true,
          });
          console.log('[MultiPaneChart] 🗄️ Initialized/Migrated SharedDataSeriesPool with WASM context');
        }
      }
      
      parentSurfaceReadyRef.current = true;

      // Trigger pane creation by updating state
      setParentSurfaceReady(true);
    } catch (e) {
      // Silently handle parent surface errors
    }
  }, [chartTheme, config.chart.timezone]);

  // Dynamic pane creation and management based on layout
  // CRITICAL: Requirement 0.1 - UI must not plot any data unless a plot layout JSON is loaded
  useEffect(() => {
    const refs = chartRefs.current;
    if (!plotLayout) {
      // No layout - do NOT create any surfaces
      // Requirement 0.1: UI continues collecting data in background but shows message
      // No SciChart panes are created automatically without a layout
      dynamicPanesInitializedRef.current = false;
      currentLayoutIdRef.current = null;
      parentSurfaceReadyRef.current = false;
      pendingPaneCreationRef.current = false;
      anyPaneHasDataRef.current = false; // CRITICAL: Reset data flag when no layout
      setParentSurfaceReady(false);

      // Clean up the pane manager (this will properly cleanup all panes and parent surface)
      if (paneManagerRef.current && !cleanupInProgressRef.current) {
        // Store reference to old manager and set to null immediately
        const oldManager = paneManagerRef.current;
        paneManagerRef.current = null;
        cleanupInProgressRef.current = true;

        // CRITICAL: Detach dataSeries from all renderableSeries BEFORE cleanup
        // This prevents "dataSeries has been deleted" errors during cleanup
        // NOTE: We do NOT delete dataSeries - they persist in sharedDataSeriesPool
        for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
          if (entry.renderableSeries) {
            try {
              (entry.renderableSeries as any).dataSeries = null;
            } catch (e) {
              // Ignore
            }
          }
        }

        // CRITICAL: Cleanup FIRST, then clear references
        // This ensures cleanup completes before we clear our tracking maps
        oldManager.cleanup().then(() => {
          console.log('[MultiPaneChart] No layout cleanup complete - dataSeries preserved in pool');

          // NOW clear our local references after cleanup is done
          refs.paneSurfaces.clear();
          
          // CRITICAL: Clear seriesHasData tracking when layout changes
          // This prevents old series data status from affecting new layout
          refs.seriesHasData.clear();
          
          // CRITICAL: Clear strategy marker scatter series tracking
          refs.markerScatterSeries.clear();

          // CRITICAL: Only clear renderableSeries references, NOT dataSeries
          // DataSeries persist in sharedDataSeriesPool across layout changes
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            // Just mark as needing new renderableSeries, keep dataSeries reference
            entry.renderableSeries = null as any;
            entry.paneId = undefined;
          }

          // Clear preallocated series tracking so series can be re-attached to new panes
          preallocatedSeriesRef.current.clear();

          // Wait additional time before allowing new surface creation
          // WASM module needs extra time to fully process deletions
          setTimeout(() => {
            // Clear cleanup flag and trigger re-render to proceed with new layout
            cleanupInProgressRef.current = false;
            setParentSurfaceReady(false); // Trigger effect re-run
            setPanesReadyCount(0); // Reset panes ready count to trigger preallocation when new panes are created
          }, 600);
        }).catch((e) => {
          // Silently handle cleanup errors (expected during layout transitions)
          console.log('[MultiPaneChart] No layout cleanup error (expected) - dataSeries preserved in pool');

          // Even on error, clear references to prevent memory leaks
          refs.paneSurfaces.clear();
          
          // CRITICAL: Clear seriesHasData tracking when layout changes
          refs.seriesHasData.clear();
          
          // CRITICAL: Clear strategy marker scatter series tracking
          refs.markerScatterSeries.clear();
          // DataSeries persist in sharedDataSeriesPool across layout changes
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              try {
                (entry.renderableSeries as any).dataSeries = null;
              } catch (e) {
                // Ignore
              }
              // Just mark as needing new renderableSeries, keep entry with dataSeries
              entry.renderableSeries = null as any;
              entry.paneId = undefined;
            }
          }
          preallocatedSeriesRef.current.clear();

          // Wait additional time before allowing new surface creation
          setTimeout(() => {
            // Clear cleanup flag and trigger re-render
            cleanupInProgressRef.current = false;
            setParentSurfaceReady(false); // Trigger effect re-run
            setPanesReadyCount(0); // Reset panes ready count to trigger preallocation when new panes are created
          }, 400);
        });
      }

      return;
    }

    // Create a stable layout ID to detect actual layout changes
    // CRITICAL: Use full JSON stringify to detect ANY change in the layout
    // This ensures reloading the same file with modifications triggers a refresh
    const layoutId = JSON.stringify(plotLayout.layout);

    // If layout changed, reset everything
    if (currentLayoutIdRef.current && currentLayoutIdRef.current !== layoutId) {
      console.log('[MultiPaneChart] Layout changed, resetting state');

      // CRITICAL: Mark chart as not-ready during teardown so callers (TradingChart)
      // can reliably detect the transition and re-run forceChartUpdate AFTER panes
      // are recreated. Without this, forceChartUpdate may run while paneSurfaces
      // is empty and then never re-run until the next live tick arrives.
      if (isReady) {
        setIsReady(false);
        onReadyChange?.(false);
      }

      // Clean up the pane manager (this will properly cleanup all panes and parent surface)
      if (paneManagerRef.current && !cleanupInProgressRef.current) {
        // Store reference to old manager and set to null immediately
        // This ensures the next render creates a NEW manager
        const oldManager = paneManagerRef.current;
        paneManagerRef.current = null;
        cleanupInProgressRef.current = true;

        // CRITICAL: Detach dataSeries from all renderableSeries BEFORE cleanup
        // This prevents "dataSeries has been deleted" errors during cleanup
        for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
          if (entry.renderableSeries) {
            try {
              (entry.renderableSeries as any).dataSeries = null;
            } catch (e) {
              // Ignore
            }
          }
        }

        // CRITICAL: Cleanup FIRST, then clear references
        // This ensures cleanup completes before we clear our tracking maps
        // NOTE: DataSeries persist in sharedDataSeriesPool - we only clear renderableSeries
        oldManager.cleanup().then(() => {
          console.log('[MultiPaneChart] Layout change cleanup complete - dataSeries preserved in pool');

          // NOW clear our local references after cleanup is done
          refs.paneSurfaces.clear();
          
          // CRITICAL: Clear seriesHasData tracking when layout changes
          // This prevents old series data status from affecting new layout
          refs.seriesHasData.clear();
          
          // CRITICAL: Clear strategy marker scatter series tracking
          refs.markerScatterSeries.clear();
          // DataSeries persist in sharedDataSeriesPool across layout changes
          // This ensures all historical data is preserved when layout changes
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            // Just mark as needing new renderableSeries, keep dataSeries reference
            entry.renderableSeries = null as any;
            entry.paneId = undefined;
          }

          // Clear preallocated series tracking so series can be re-attached to new panes
          preallocatedSeriesRef.current.clear();

          // Wait additional time before allowing new surface creation
          // WASM module needs extra time to fully process deletions
          setTimeout(() => {
            // Clear cleanup flag and trigger re-render to proceed with new layout
            cleanupInProgressRef.current = false;
            setParentSurfaceReady(false); // Trigger effect re-run
            setPanesReadyCount(0); // Reset panes ready count to trigger preallocation when new panes are created
          }, 600);
        }).catch((e) => {
          // Silently handle cleanup errors (expected during layout transitions)
          console.log('[MultiPaneChart] Layout change cleanup error (expected) - dataSeries preserved in pool');

          // Even on error, clear references to prevent memory leaks
          refs.paneSurfaces.clear();
          
          // CRITICAL: Clear seriesHasData tracking when layout changes
          refs.seriesHasData.clear();
          
          // CRITICAL: Clear strategy marker scatter series tracking
          refs.markerScatterSeries.clear();
          
          // CRITICAL: Only clear renderableSeries references, NOT dataSeries
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              try {
                (entry.renderableSeries as any).dataSeries = null;
              } catch (e) {
                // Ignore
              }
              entry.renderableSeries = null as any;
              entry.paneId = undefined;
            }
          }
          preallocatedSeriesRef.current.clear();

          // Wait additional time before allowing new surface creation
          setTimeout(() => {
            // Clear cleanup flag and trigger re-render
            cleanupInProgressRef.current = false;
            setParentSurfaceReady(false); // Trigger effect re-run
            setPanesReadyCount(0); // Reset panes ready count to trigger preallocation when new panes are created
          }, 400);
        });
      }

      // Reset all state flags
      dynamicPanesInitializedRef.current = false;
      parentSurfaceReadyRef.current = false;
      pendingPaneCreationRef.current = false;
      currentLayoutIdRef.current = null;
      anyPaneHasDataRef.current = false; // CRITICAL: Reset data flag on layout change
      
      // CRITICAL: Reset user interaction flags on layout change
      // This allows forceChartUpdate to properly align X-axis to historical data
      // Without this, loading a new layout after interacting with a previous layout
      // would prevent the X-axis from aligning to the data range
      userInteractedRef.current = false;
      timeWindowSelectedRef.current = false;
      
      setParentSurfaceReady(false);
      setPanesReadyCount(0); // CRITICAL: Reset panesReadyCount so preallocation effect re-runs when new panes are created

      // CRITICAL: Return early and let the effect re-run on the next render cycle
      // This ensures cleanup is complete before we try to create new surfaces
      return;
    }

    // If this is the same layout and already initialized, skip
    if (dynamicPanesInitializedRef.current && currentLayoutIdRef.current === layoutId) {
      return;
    }

    // CRITICAL: If cleanup is in progress, wait for it to complete before creating new surfaces
    // This prevents "measureText" errors from queued render frames during cleanup
    if (cleanupInProgressRef.current) {
      console.log('[MultiPaneChart] Cleanup in progress, waiting for completion before creating surfaces');
      return;
    }

    // Initialize pane manager with theme and timezone (theme is defined above)
    if (!paneManagerRef.current) {
      paneManagerRef.current = new DynamicPaneManager(chartTheme, config.chart.timezone || 'UTC');
    }
    const paneManager = paneManagerRef.current;
    
    // Update zoom mode when it changes
    paneManager.setZoomMode(zoomMode);
    
    // Update timezone when it changes
    paneManager.setTimezone(config.chart.timezone || 'UTC');
    
    // Update theme when it changes
    paneManager.setTheme(chartTheme);
    
    // NOTE: X-axis range sync is handled inside DynamicPaneManager.
    // We intentionally do NOT change live/session/sticky modes on manual pan/zoom here;
    // the toolbar (Pause/Live) and minimap interactions control those modes.
    paneManager.onXAxisManualChange = undefined;
    
    // Set up zoom interaction callback to trigger pause mode on wheel/box zoom
    paneManager.onZoomInteraction = () => {
      isLiveRef.current = false;
      userInteractedRef.current = true;
      minimapStickyRef.current = false;
      // Clear any pending interaction timeout
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
        interactionTimeoutRef.current = null;
      }
    };

    // For dynamic layouts, we don't need to wait for legacy isReady
    // We'll set isReady after creating the first pane

    let isMounted = true;

    const createDynamicPanes = async () => {
      console.log('[MultiPaneChart] createDynamicPanes called', {
        hasWasm: !!refs.sharedWasm,
        parentReady: parentSurfaceReadyRef.current,
        parentSurfaceReadyState: parentSurfaceReady,
        hasPaneManager: !!paneManagerRef.current
      });
      
      try {
        // Parent surface initialization is now handled by onGridReady callback
        // Wait for parent surface to be ready before creating panes
        if (!parentSurfaceReadyRef.current) {
          console.log('[MultiPaneChart] Parent surface not ready, setting pending flag');
          pendingPaneCreationRef.current = true;
          return; // Exit and wait for onGridReady callback
        }

        // Only initialize WASM once globally (not on every layout change)
        if (!refs.sharedWasm) {
          console.log('[MultiPaneChart] WASM not ready yet, will be set by pane manager');
        }

        // Wait for DOM to be fully ready (containers need to be rendered)
        await new Promise(resolve => setTimeout(resolve, 100));
        await new Promise(resolve => requestAnimationFrame(resolve));

        // Check if all panes already exist (prevent re-creation)
        const allPanesExist = plotLayout.layout.panes.every(paneConfig => {
          const existingPane = refs.paneSurfaces.get(paneConfig.id);
          return existingPane !== undefined;
        });

        if (allPanesExist && dynamicPanesInitializedRef.current) {
          console.log('[MultiPaneChart] All panes already exist, skipping creation');
          currentLayoutIdRef.current = layoutId;
          return;
        }

        console.log('[MultiPaneChart] Creating panes for layout:', plotLayout.layout.panes.map(p => p.id));
        
        // CRITICAL: Create panes SEQUENTIALLY to prevent race conditions
        // Creating multiple subsurfaces in parallel can cause "measureText" errors
        // because the rendering context isn't fully initialized before SciChart starts drawing
        
        for (const paneConfig of plotLayout.layout.panes) {
          if (creatingPanesRef.current.has(paneConfig.id)) {
            continue; // Already creating this pane
          }

          // Check if pane already exists before adding to creating set
          const existingPane = refs.paneSurfaces.get(paneConfig.id);
          if (existingPane) {
            continue; // Already exists, skip
          }

          creatingPanesRef.current.add(paneConfig.id);

          // SEQUENTIAL: Create each pane one at a time to prevent race conditions
          try {
            const containerId = `pane-${paneConfig.id}-chart`;
            // Note: With SubCharts API, individual containers are not needed
            // The parent surface handles all rendering
            // We still pass the containerId for reference but don't require the DOM element

            // Check if pane already exists
            const existingPaneCheck = refs.paneSurfaces.get(paneConfig.id);
            if (existingPaneCheck) {
              creatingPanesRef.current.delete(paneConfig.id);
              continue; // Already exists
            }

            console.log('[MultiPaneChart] Creating pane:', paneConfig.id);
            const paneSurface = await paneManager.createPane(
              paneConfig.id,
              containerId,
              paneConfig,
              config.performance.maxAutoTicks,
              config.chart.separateXAxes
            );
            console.log('[MultiPaneChart] Pane created successfully:', paneConfig.id);

            if (!isMounted) {
              paneManager.destroyPane(paneConfig.id);
              continue;
            }

            // Store in refs
            refs.paneSurfaces.set(paneConfig.id, paneSurface);
            
            // Create strategy marker scatter series if this pane is eligible
            // Check BOTH legacy global config AND explicit strategy series assignment
            const isLegacyMarkerPane = plotLayout?.strategyMarkerPanes?.has(paneConfig.id);
            const isExplicitMarkerPane = plotLayout ? Array.from(plotLayout.strategySeriesMap.values()).some(
              assignments => assignments.some(sa => sa.pane === paneConfig.id && (sa.type === 'strategy_markers' || sa.type === 'strategy_signals'))
            ) : false;
            
            if (isLegacyMarkerPane || isExplicitMarkerPane) {
              const capacity = config.data?.buffers.pointsPerSeries ?? 100000;
              // Get markerStyle from the explicit assignment if available
              const paneStrategyAssignment = plotLayout ? Array.from(plotLayout.strategySeriesMap.values()).flat().find(
                sa => sa.pane === paneConfig.id && (sa.type === 'strategy_markers' || sa.type === 'strategy_signals')
              ) : undefined;
              const scatterSeriesMap = createAllMarkerScatterSeries(paneSurface.wasm, capacity, paneConfig.id, paneStrategyAssignment?.markerStyle);
              refs.markerScatterSeries.set(paneConfig.id, scatterSeriesMap);
              
              // Add all 5 scatter series to the surface
              for (const group of scatterSeriesMap.values()) {
                paneSurface.surface.renderableSeries.add(group.renderableSeries);
              }
              console.log(`[MultiPaneChart] Created strategy marker scatter series for pane: ${paneConfig.id} (legacy=${isLegacyMarkerPane}, explicit=${isExplicitMarkerPane})`);
            }
            
            // FPS tracking is now handled by requestAnimationFrame at the top level
            // No need to subscribe to surface rendered events
            
            // Remove ZoomExtentsModifier completely - we'll handle all double-click behavior ourselves
            // This gives us full control over the behavior
            setTimeout(() => {
              const modifiers = paneSurface.surface.chartModifiers.asArray();
              for (const mod of modifiers) {
                if (mod instanceof ZoomExtentsModifier) {
                  paneSurface.surface.chartModifiers.remove(mod);
                }
              }
            }, 100); // Small delay to ensure modifiers are added
            
            // Add double-click handler for fit-all + pause
            // Requirement 22.1: Double-click = fit-all + pause
            // Modified: In paused mode, fit both X and Y simultaneously
            // X-axis uses minimap range or time window range
            const surfaceElement = paneSurface.surface.domCanvas2D;
            if (surfaceElement) {
              // Handle all double-click behavior ourselves
              // Always fit both X and Y simultaneously, using minimap/time window range for X
              // This works in both live and paused mode
              surfaceElement.addEventListener('dblclick', (e) => {
                // Always handle double-click ourselves for consistent behavior
                // CRITICAL: Prevent default and stop all propagation to ensure no other handlers run
                // This works in all modes: live, paused, history, and session complete
                console.log(`[MultiPaneChart] Double-click detected on ${paneConfig.id}, feedStage: ${feedStageRef.current}`);
                
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                
                // Also prevent the event from reaching SciChart's modifier system
                // by stopping it at the capture phase
                if (e.cancelable) {
                  e.preventDefault();
                }
                
                // Get the X-axis range based on current time window selection
                // CRITICAL: Use selectedWindowMinutesRef and sessionModeRef as the source of truth,
                // NOT the minimap's selectedArea, which can be stale from a previous selection.
                let xRange: NumberRange | null = null;
                let useZoomExtentsX = false;
                
                const selectedMinutes = selectedWindowMinutesRef.current;
                const isSessionMode = sessionModeRef.current;
                const latestTime = lastDataTimeRef.current > 0 ? lastDataTimeRef.current : Date.now();
                
                console.log(`[MultiPaneChart] Double-click range calc: selectedMinutes=${selectedMinutes}, sessionMode=${isSessionMode}`);
                
                if (isSessionMode || (selectedMinutes === null && !isSessionMode)) {
                  // Entire session mode or no specific window: zoom to full data extents
                  useZoomExtentsX = true;
                } else if (selectedMinutes !== null && selectedMinutes > 0) {
                  // Specific time window: calculate the range
                  const windowSec = selectedMinutes * 60;
                  const endSec = latestTime / 1000;
                  const startSec = endSec - windowSec;
                  const paddingSec = windowSec * 0.02;
                  xRange = new NumberRange(startSec, endSec + paddingSec);
                } else {
                  // Fallback: zoom to full data extents
                  useZoomExtentsX = true;
                }
                
                // Suspend updates on all surfaces to batch the operations
                const surfacesToResume: any[] = [];
                for (const [, otherPaneSurface] of chartRefs.current.paneSurfaces) {
                  try {
                    otherPaneSurface.surface.suspendUpdates();
                    surfacesToResume.push(otherPaneSurface.surface);
                  } catch (e) {}
                }
                if (chartRefs.current.tickSurface) {
                  try {
                    chartRefs.current.tickSurface.suspendUpdates();
                    surfacesToResume.push(chartRefs.current.tickSurface);
                  } catch (e) {}
                }
                if (chartRefs.current.ohlcSurface) {
                  try {
                    chartRefs.current.ohlcSurface.suspendUpdates();
                    surfacesToResume.push(chartRefs.current.ohlcSurface);
                  } catch (e) {}
                }
                
                try {
                  // CRITICAL: Reset Y-axis manual stretch flag so auto-scaling resumes after double-click
                  yAxisManuallyStretchedRef.current = false;
                  lastYAxisUpdateRef.current = 0;
                  
                  // CRITICAL: Fit Y-axis FIRST for ALL panes simultaneously
                  // This ensures Y-axis is properly scaled regardless of zoom level or feedStage
                  // Force recalculation by calling zoomExtentsY which works even when zoomed in
                  console.log(`[MultiPaneChart] Fitting Y-axis for all panes, feedStage: ${feedStageRef.current}`);
                  
                  for (const [paneId, otherPaneSurface] of chartRefs.current.paneSurfaces) {
                    try {
                      // Force Y-axis to recalculate including hlines
                      // This works even when the chart is zoomed in too much or session is complete
                      // CRITICAL: Use zoomExtentsYWithHLines to include hline Y values
                      zoomExtentsYWithHLines(otherPaneSurface.surface, paneId);
                      // Force immediate update
                      otherPaneSurface.surface.invalidateElement();
                    } catch (e) {
                      console.warn(`[MultiPaneChart] Failed to zoom Y extents for pane:`, e);
                    }
                  }
                  // Also apply to legacy surfaces if they exist
                  try {
                    chartRefs.current.tickSurface?.zoomExtentsY();
                    chartRefs.current.tickSurface?.invalidateElement();
                    chartRefs.current.ohlcSurface?.zoomExtentsY();
                    chartRefs.current.ohlcSurface?.invalidateElement();
                  } catch (e) {
                    // Fallback for legacy surfaces too
                    try {
                      chartRefs.current.tickSurface?.zoomExtents();
                      chartRefs.current.tickSurface?.invalidateElement();
                      chartRefs.current.ohlcSurface?.zoomExtents();
                      chartRefs.current.ohlcSurface?.invalidateElement();
                    } catch (e2) {
                      console.warn(`[MultiPaneChart] Failed to zoom Y extents on legacy surfaces:`, e2);
                    }
                  }
                  
                  // Fit X-axis to minimap/time window range or extents
                  // Apply to all panes since X-axes are linked
                  console.log(`[MultiPaneChart] Setting X-axis range, hasRange: ${!!xRange}, useZoomExtentsX: ${useZoomExtentsX}`);
                  
                  if (xRange) {
                    // Set X-axis to the minimap/time window range for all panes
                    // Ensure we're using the correct range (minimap uses seconds, same as X-axis)
                    // CRITICAL: Apply the range directly to ensure it's set correctly
                    console.log(`[MultiPaneChart] Applying X-axis range: ${xRange.min} to ${xRange.max}`);
                    
                    for (const [, otherPaneSurface] of chartRefs.current.paneSurfaces) {
                      if (otherPaneSurface.xAxis) {
                        // Create a new NumberRange to ensure it's properly set
                        otherPaneSurface.xAxis.visibleRange = new NumberRange(xRange.min, xRange.max);
                        // Force immediate update
                        otherPaneSurface.surface.invalidateElement();
                      }
                    }
                    // Also apply to legacy surfaces if they exist
                    if (chartRefs.current.tickSurface?.xAxes.get(0)) {
                      chartRefs.current.tickSurface.xAxes.get(0)!.visibleRange = new NumberRange(xRange.min, xRange.max);
                      chartRefs.current.tickSurface.invalidateElement();
                    }
                    if (chartRefs.current.ohlcSurface?.xAxes.get(0)) {
                      chartRefs.current.ohlcSurface.xAxes.get(0)!.visibleRange = new NumberRange(xRange.min, xRange.max);
                      chartRefs.current.ohlcSurface.invalidateElement();
                    }
                  } else if (useZoomExtentsX) {
                    // Entire session: calculate the full data range from all series
                    // This ensures we get the correct range from all data, not just visible
                    // CRITICAL: This works even when session is complete
                    let globalDataMin: number | null = null;
                    let globalDataMax: number | null = null;
                    
                    // Get the full data range from all series in the data store
                    for (const [, entry] of chartRefs.current.dataSeriesStore) {
                      if (entry.dataSeries) {
                        try {
                          const xRange = entry.dataSeries.getXRange();
                          if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
                            if (globalDataMin === null || xRange.min < globalDataMin) {
                              globalDataMin = xRange.min;
                            }
                            if (globalDataMax === null || xRange.max > globalDataMax) {
                              globalDataMax = xRange.max;
                            }
                          }
                        } catch (e) {
                          // Ignore errors
                        }
                      }
                    }
                    
                    // Also check minimap data series if available (for session complete case)
                    const minimapDataSeries = (chartRefs.current as any).minimapDataSeries as any;
                    if (minimapDataSeries && minimapDataSeries.getXRange) {
                      try {
                        const minimapRange = minimapDataSeries.getXRange();
                        if (minimapRange && isFinite(minimapRange.min) && isFinite(minimapRange.max)) {
                          if (globalDataMin === null || minimapRange.min < globalDataMin) {
                            globalDataMin = minimapRange.min;
                          }
                          if (globalDataMax === null || minimapRange.max > globalDataMax) {
                            globalDataMax = minimapRange.max;
                          }
                        }
                      } catch (e) {
                        // Ignore errors
                      }
                    }
                    
                    if (globalDataMin !== null && globalDataMax !== null && globalDataMin < globalDataMax) {
                      // Add small padding
                      const padding = (globalDataMax - globalDataMin) * 0.02;
                      const fullRange = new NumberRange(globalDataMin - padding, globalDataMax + padding);
                      
                      console.log(`[MultiPaneChart] Calculated full data range: ${fullRange.min} to ${fullRange.max}`);
                      
                      // Apply the calculated range to all panes
                      for (const [, otherPaneSurface] of chartRefs.current.paneSurfaces) {
                        if (otherPaneSurface.xAxis) {
                          otherPaneSurface.xAxis.visibleRange = fullRange;
                          // Force immediate update
                          otherPaneSurface.surface.invalidateElement();
                        }
                      }
                      // Also apply to legacy surfaces if they exist
                      if (chartRefs.current.tickSurface?.xAxes.get(0)) {
                        chartRefs.current.tickSurface.xAxes.get(0)!.visibleRange = fullRange;
                        chartRefs.current.tickSurface.invalidateElement();
                      }
                      if (chartRefs.current.ohlcSurface?.xAxes.get(0)) {
                        chartRefs.current.ohlcSurface.xAxes.get(0)!.visibleRange = fullRange;
                        chartRefs.current.ohlcSurface.invalidateElement();
                      }
                    } else {
                      // Fallback: use zoomExtentsX if we can't calculate the range
                      // This should work even when session is complete
                      console.log(`[MultiPaneChart] Using zoomExtentsX fallback (couldn't calculate range)`);
                      
                      for (const [, otherPaneSurface] of chartRefs.current.paneSurfaces) {
                        try {
                          otherPaneSurface.surface.zoomExtentsX();
                          // Force immediate update
                          otherPaneSurface.surface.invalidateElement();
                        } catch (e) {
                          console.warn(`[MultiPaneChart] Failed to zoom X extents:`, e);
                        }
                      }
                      // Also apply to legacy surfaces if they exist
                      try {
                        chartRefs.current.tickSurface?.zoomExtentsX();
                        chartRefs.current.tickSurface?.invalidateElement();
                        chartRefs.current.ohlcSurface?.zoomExtentsX();
                        chartRefs.current.ohlcSurface?.invalidateElement();
                      } catch (e) {
                        console.warn(`[MultiPaneChart] Failed to zoom X extents on legacy surfaces:`, e);
                      }
                    }
                  }
                } finally {
                  // Resume updates immediately to ensure changes are applied
                  // CRITICAL: Resume synchronously, then do post-fit operations in next frame
                  for (const surface of surfacesToResume) {
                    try {
                      surface.resumeUpdates();
                    } catch (e) {}
                  }

                  // Next frame: with X-range applied + updates resumed, fit Y to the new visible X-range
                  requestAnimationFrame(() => {
                    try {
                      console.log(`[MultiPaneChart] Post-double-click: fitting Y after X-range applied`);
                      for (const [paneId, otherPaneSurface] of chartRefs.current.paneSurfaces) {
                        try {
                          zoomExtentsYWithHLines(otherPaneSurface.surface, paneId);
                        } catch (e) {}
                      }
                      try {
                        chartRefs.current.tickSurface?.zoomExtentsY();
                        chartRefs.current.ohlcSurface?.zoomExtentsY();
                      } catch (e) {}
                    } finally {
                      for (const surface of surfacesToResume) {
                        try {
                          surface.invalidateElement();
                        } catch (e) {}
                      }
                      console.log(`[MultiPaneChart] Double-click operations completed, feedStage: ${feedStageRef.current}`);
                    }
                  });
                }
                
                // Pause auto-scroll when double-clicking (works in both live and paused mode)
                isLiveRef.current = false;
                userInteractedRef.current = true;
                // Clear any pending timeout
                if (interactionTimeoutRef.current) {
                  clearTimeout(interactionTimeoutRef.current);
                  interactionTimeoutRef.current = null;
                }
              }, { capture: true }); // Use capture phase to run before SciChart's modifier
              
              // Add user interaction detection for pan/zoom; we no longer sync main chart
              // back into minimap selection to keep minimap window edges fixed where
              // the user placed them. Minimap is controlled only by its own drag and
              // Last X Time Window presets.
              const syncMinimapSelection = () => {
                // CRITICAL: In live mode, axis drag/stretch should NOT disable auto-scroll
                // Only disable sticky mode if user is NOT in live mode
                // This allows axis stretching while maintaining auto-scroll in live mode
                setTimeout(() => {
                  // Don't disable sticky mode or set interacted if we're in live mode
                  // This allows axis stretching to work without breaking auto-scroll
                  if (!isLiveRef.current) {
                    minimapStickyRef.current = false;
                    userInteractedRef.current = true;
                  }
                  // When in live mode, keep minimapStickyRef.current unchanged
                  // so auto-scroll continues working after axis stretch
                }, 50);
              };
              
              // Detect Y-axis drag to set manual stretch flag
              // Y-axis is typically on the right side of the chart
              let yAxisDragging = false;
              surfaceElement.addEventListener('mousedown', (e: MouseEvent) => {
                const rect = surfaceElement.getBoundingClientRect();
                const x = e.clientX - rect.left;
                // Y-axis area is typically the rightmost ~60px of the chart
                const yAxisAreaWidth = 60;
                if (x > rect.width - yAxisAreaWidth) {
                  yAxisDragging = true;
                }
              }, { passive: true });
              
              surfaceElement.addEventListener('mouseup', () => {
                if (yAxisDragging) {
                  // User finished dragging Y-axis - set manual stretch flag
                  yAxisManuallyStretchedRef.current = true;
                  yAxisDragging = false;
                }
              }, { passive: true });
              
              // Still listen to interactions so we can pause auto-scroll, but do NOT
              // alter the minimap selection box from main chart interactions.
              surfaceElement.addEventListener('mouseup', syncMinimapSelection, { passive: true });
              surfaceElement.addEventListener('touchend', syncMinimapSelection, { passive: true });
              surfaceElement.addEventListener('wheel', syncMinimapSelection, { passive: true });
            }
            
            // Store shared WASM from first pane and create vertical group
            if (!refs.sharedWasm) {
              refs.sharedWasm = paneSurface.wasm;
              
              // REQUIREMENT: All charts must have linked X-axes
              // Always create vertical group to link X-axes across all panes
              if (!refs.verticalGroup) {
                const vGroup = paneManager.createVerticalGroup(paneSurface.wasm);
                refs.verticalGroup = vGroup;
              }
            }
            
            // Add to vertical group to link X-axes across all panes
            // REQUIREMENT: All panes must have their own X-axis, all linked and synchronized
            // When one pane's X-axis changes (via minimap, time window, or manual interaction),
            // all other panes will follow the same X-axis range
            if (refs.verticalGroup) {
              try {
                refs.verticalGroup.addSurfaceToGroup(paneSurface.surface);
                console.log(`[MultiPaneChart] Added pane ${paneConfig.id} to vertical group for linked X-axes`);
              } catch (e) {
                // Ignore if already in group
                console.warn(`[MultiPaneChart] Pane ${paneConfig.id} already in vertical group or error:`, e);
              }
            }
            
            // Requirement 0.3: PnL pane must have proper Y-axis scaling for negative/positive values
            // Check if this is a PnL pane by checking if it contains PnL series
            // STRICT: PnL pane is ONLY determined by series assignment, not pane ID/title patterns
            // Check if this pane has a strategy-pnl series explicitly assigned in layout
            const isPnLPane = plotLayout.layout.series.some(s => {
              const seriesInfo = parseSeriesType(s.series_id);
              return seriesInfo.type === 'strategy-pnl' && s.pane === paneConfig.id;
            });
            
            if (isPnLPane) {
              // Configure Y-axis for PnL: ensure it can handle both positive and negative values
              // Use Once instead of Always to prevent constant re-scaling that causes zoom issues
              // The manual Y-axis scaling in processBatchedSamples will handle updates
              paneSurface.yAxis.autoRange = EAutoRange.Once;
              // Set growBy to 10% (same as other panes) to show more area/view more data
              paneSurface.yAxis.growBy = new NumberRange(0.1, 0.1);
            }
            
            // Register with layout manager
            layoutManager.registerPane(paneConfig.id, {
              paneId: paneConfig.id,
              surface: paneSurface.surface,
              wasm: paneSurface.wasm,
              xAxis: paneSurface.xAxis,
              yAxis: paneSurface.yAxis,
              containerId: containerId,
              hasData: false,
              waitingForData: true,
            });
            
            // Initialize waiting overlay for this pane
            // Check which assigned series have data and show pending count
            updatePaneWaitingOverlay(refs, layoutManager, paneConfig.id, plotLayout);

            // Requirement 0.4: Strategy markers must appear on all eligible panes (except PnL and bar plots)
            // Create strategy marker copies for this pane if it's eligible
            // We'll create these during preallocation to avoid DataSeries sharing issues
            // This is just a placeholder - actual duplication happens in preallocation useEffect

            // Add overlays (hlines/vlines) if specified
            console.log(`[MultiPaneChart] Checking overlays for pane ${paneConfig.id}:`, paneConfig.overlays);
            if (paneConfig.overlays) {
              // Render horizontal lines
              if (paneConfig.overlays.hline && paneConfig.overlays.hline.length > 0) {
                console.log(`[MultiPaneChart] Rendering ${paneConfig.overlays.hline.length} hlines for pane ${paneConfig.id}`);
                renderHorizontalLines(paneSurface.surface, paneSurface.wasm, paneConfig.overlays.hline, paneConfig.id);
              }
              
              // Render vertical lines
              if (paneConfig.overlays.vline && paneConfig.overlays.vline.length > 0) {
                console.log(`[MultiPaneChart] Rendering ${paneConfig.overlays.vline.length} vlines for pane ${paneConfig.id}`);
                renderVerticalLines(paneSurface.surface, paneSurface.wasm, paneConfig.overlays.vline, paneConfig.id);
              }
            }

            // Wait a small amount between pane creations to let the rendering context fully initialize
            await new Promise(resolve => requestAnimationFrame(resolve));
            
          } catch (error) {
            // Silently handle pane creation error
            console.warn('[MultiPaneChart] Error creating pane:', paneConfig.id, error);
          } finally {
            creatingPanesRef.current.delete(paneConfig.id);
          }
        }
        
        console.log('[MultiPaneChart] All panes created sequentially, paneSurfaces size:', refs.paneSurfaces.size);
        
        console.log('[MultiPaneChart] All pane promises resolved, paneSurfaces size:', refs.paneSurfaces.size);

        // Mark as initialized after successful creation
        dynamicPanesInitializedRef.current = true;
        currentLayoutIdRef.current = layoutId;
        
        // Update waiting annotations after all panes are created
        updateWaitingAnnotations();
        
        // CRITICAL: Trigger preallocation by updating a state that the effect depends on
        // This ensures preallocation runs after panes are created, and will re-run when registry arrives
        console.log(`[MultiPaneChart] ✅ All ${refs.paneSurfaces.size} panes created, triggering preallocation check (registry: ${registry.length} series)`);
        setPanesReadyCount(refs.paneSurfaces.size);

        // Set isReady after creating panes OR if parent surface is ready (for dynamic layouts)
        // This ensures the "Initializing Chart" overlay is removed
        if (!isReady) {
          console.log('[MultiPaneChart] Setting isReady = true');
          setIsReady(true);
          onReadyChange?.(true);
        }
        
        // CRITICAL: Post-initialization check will be triggered when registry arrives
        // See the preallocation effect for the actual trigger
        
        // CRITICAL: Trigger overview refresh after panes are created
        // This ensures the minimap recreates with the new source surface
        // Use a small delay to ensure series have been added to surfaces
        setTimeout(() => {
          console.log('[MultiPaneChart] Triggering overview refresh after pane creation');
          setOverviewNeedsRefresh(prev => prev + 1);
        }, 500);
        
        // CRITICAL: The setPanesReadyCount call above will trigger the preallocation useEffect
        // The useEffect will handle preallocation when both panes and registry are ready
        // This ensures consistent behavior regardless of whether panes or registry arrive first
        // The useEffect is the single source of truth for preallocation
        
        // Manual preallocation fallback: if registry already has data when panes are created,
        // trigger immediate preallocation (the useEffect will also run, but this ensures it happens quickly)
        if (registry.length > 0 && refs.paneSurfaces.size === plotLayout.layout.panes.length) {
          console.log(`[MultiPaneChart] 🚀 Panes ready with ${registry.length} series in registry, triggering immediate preallocation`);
          setTimeout(() => {
            const refs = chartRefs.current;
            const capacity = getSeriesCapacity();
            let createdCount = 0;
            
            registry.forEach(regEntry => {
              const seriesId = regEntry.id;
              
              // Check if series exists but is orphaned (has DataSeries but no renderableSeries or paneId)
              const existingEntry = refs.dataSeriesStore.get(seriesId);
              if (existingEntry) {
                // If series exists but is orphaned (no renderableSeries or paneId), we need to recreate it
                if (!existingEntry.renderableSeries || !existingEntry.paneId) {
               
                  // Clear from preallocated set so it can be recreated
                  preallocatedSeriesRef.current.delete(seriesId);
                  // Don't return - continue to recreate the renderableSeries
                } else {
                  // Series is already fully created and assigned to a pane
                  return;
                }
              } else if (preallocatedSeriesRef.current.has(seriesId)) {
                // Series is marked as preallocated but doesn't exist in store - clear the flag
                preallocatedSeriesRef.current.delete(seriesId);
                // Continue to create it
              }
              
              const seriesInfo = parseSeriesType(seriesId);
              
              // Strategy markers & signals are rendered as annotations, not chart series
              if (seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') return;
              if (seriesInfo.chartTarget === 'none') return;
              
              // Silently skip series not defined in the layout
              if (!isSeriesInLayout(seriesId)) return;
              
              try {
                const { paneId, surface, wasm } = getPaneForSeries(seriesId);
                if (!wasm || !surface || !paneId) {
                  // Surface not ready yet - will be created when panes are initialized
                  return;
                }
                
                // Mark as preallocated
                preallocatedSeriesRef.current.add(seriesId);
                
                // Check if we should reuse existing DataSeries (for orphaned series)
                const existingEntryForReuse = refs.dataSeriesStore.get(seriesId);
                const shouldReuseDataSeries = existingEntryForReuse && existingEntryForReuse.dataSeries && (!existingEntryForReuse.renderableSeries || !existingEntryForReuse.paneId);
                
                // Create series using the same logic as preallocation useEffect
                const renderableSeriesType = getRenderableSeriesType(seriesId);
                const dataSeriesWasm = refs.sharedWasm || wasm;
                
                let dataSeries: XyDataSeries | OhlcDataSeries;
                let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
                
                // CRITICAL: First check sharedDataSeriesPool - this is the single source of truth
                // for DataSeries instances. Data from WebSocket goes to the pool, so we MUST
                // use the same DataSeries from the pool for the renderableSeries
                const pooledEntry = sharedDataSeriesPool.get(seriesId);
                
                // PRIORITY ORDER for reusing dataSeries:
                // 1. sharedDataSeriesPool (persists across ALL layout changes - most reliable)
                // 2. existing dataSeriesStore entry (legacy orphaned series)
                // 3. Create new via pool's getOrCreate (ensures pool consistency)
                if (pooledEntry && pooledEntry.dataSeries) {
                  // BEST CASE: Reuse from shared pool - this preserves ALL data across layout changes
                  dataSeries = pooledEntry.dataSeries;
                  console.log(`[MultiPaneChart] ♻️ Initial prealloc: Reusing dataSeries from pool: ${seriesId} (${dataSeries.count()} points)`);
                } else if (shouldReuseDataSeries && existingEntryForReuse.dataSeries) {
                  // Fallback: Reuse from legacy store
                  dataSeries = existingEntryForReuse.dataSeries;
                  console.log(`[MultiPaneChart] ♻️ Initial prealloc: Reusing dataSeries from store: ${seriesId}`);
                } else {
                  // Create new DataSeries via the pool (ensures consistency)
                  const seriesPoolType = (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') ? 'ohlc' : 'xy';
                  const newPooledEntry = sharedDataSeriesPool.getOrCreate(seriesId, seriesPoolType);
                  if (!newPooledEntry) {
                    console.warn(`[MultiPaneChart] ❌ Failed to create dataSeries via pool: ${seriesId}`);
                    return;
                  }
                  dataSeries = newPooledEntry.dataSeries;
                  console.log(`[MultiPaneChart] 🆕 Initial prealloc: Created dataSeries via pool: ${seriesId}`);
                }
                
                // Create renderableSeries (always create new, even if reusing DataSeries)
                if (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') {
                  renderableSeries = new FastCandlestickRenderableSeries(wasm, {
                    dataSeries: dataSeries as OhlcDataSeries,
                    strokeUp: '#26a69a',
                    brushUp: '#26a69a88',
                    strokeDown: '#ef5350',
                    brushDown: '#ef535088',
                    strokeThickness: 1,
                  });
                } else {
                  const seriesAssignment = plotLayout?.layout.series.find(s => s.series_id === seriesId);
                  let stroke = seriesAssignment?.style?.stroke;
                  if (!stroke) {
                    stroke = '#50C7E0';
                    if (seriesInfo.isIndicator) {
                      stroke = '#F48420';
                    } else if (seriesInfo.type === 'strategy-pnl') {
                      stroke = '#4CAF50';
                    }
                  }
                  
                  const strokeThickness = seriesAssignment?.style?.strokeThickness ?? 1;
                  const fill = seriesAssignment?.style?.fill ?? (stroke + '44');
                  const pointMarker = seriesAssignment?.style?.pointMarker ? undefined : undefined;
                  
                  if (renderableSeriesType === 'FastMountainRenderableSeries') {
                    renderableSeries = new FastMountainRenderableSeries(wasm, {
                      dataSeries: dataSeries as XyDataSeries,
                      stroke: stroke,
                      fill: fill,
                      strokeThickness: strokeThickness,
                      pointMarker: pointMarker,
                      resamplingMode: getResamplingMode(),
                      resamplingPrecision: getResamplingPrecision(),
                    });
                  } else {
                    renderableSeries = new FastLineRenderableSeries(wasm, {
                      dataSeries: dataSeries as XyDataSeries,
                      stroke: stroke,
                      strokeThickness: strokeThickness,
                      pointMarker: pointMarker,
                      resamplingMode: getResamplingMode(),
                      resamplingPrecision: getResamplingPrecision(),
                    });
                  }
                }
                
                const entry: DataSeriesEntry = {
                  dataSeries,
                  renderableSeries,
                  chartTarget: seriesInfo.chartTarget,
                  paneId: paneId,
                  seriesType: seriesInfo.type,
                  renderableSeriesType: renderableSeriesType,
                };
                refs.dataSeriesStore.set(seriesId, entry);
                surface.renderableSeries.add(renderableSeries);
                
                const isInLayout = plotLayout?.layout.series.some(s => s.series_id === seriesId);
                if (visibleSeries) {
                  renderableSeries.isVisible = visibleSeries.has(seriesId) || isInLayout;
                } else {
                  renderableSeries.isVisible = isInLayout !== false;
                }
                
                
                surface.invalidateElement();
                createdCount++;
              } catch (e) {
                console.warn(`[MultiPaneChart] Failed to preallocate ${seriesId} after pane creation:`, e);
                preallocatedSeriesRef.current.delete(seriesId);
              }
            });
            
            if (createdCount > 0) {
              console.log(`[MultiPaneChart] ✅ Manually preallocated ${createdCount} series after pane creation`);
            } else if (registry.length > 0) {
              console.warn(`[MultiPaneChart] ⚠️ No series were created after pane creation (registry has ${registry.length} series, dataSeriesStore has ${refs.dataSeriesStore.size} series)`);
            }
          }, 100); // Small delay to ensure all panes are registered
        }

        // Cleanup panes that are no longer in layout
        const currentPaneIds = new Set(plotLayout.layout.panes.map(p => p.id));
        for (const [paneId, paneSurface] of refs.paneSurfaces) {
          if (!currentPaneIds.has(paneId)) {
          
            
            // CRITICAL: Remove ALL RenderableSeries from this pane before destroying it
            // This prevents "DataSeries has been deleted" errors
            // CRITICAL: Detach dataSeries reference before removing to prevent it from being deleted
            try {
              const renderableSeriesToRemove: any[] = [];
              paneSurface.surface.renderableSeries.asArray().forEach((rs: any) => {
                renderableSeriesToRemove.push(rs);
              });
              
              for (const rs of renderableSeriesToRemove) {
                try {
                  // CRITICAL: Detach dataSeries before removing to prevent it from being deleted
                  // This prevents "DataSeries has been deleted" errors when the surface is destroyed
                  if (rs.dataSeries) {
                    rs.dataSeries = null;
                  }
                  paneSurface.surface.renderableSeries.remove(rs);
                } catch (e) {
                  // Ignore if already removed
                }
              }
            } catch (e) {
              console.warn(`[MultiPaneChart] Error removing RenderableSeries from pane ${paneId}:`, e);
            }
            
            // Orphan series from this pane - they will be recreated with new DataSeries when new panes are ready
            // CRITICAL: Do NOT migrate series by sharing DataSeries - this causes "DataSeries has been deleted" errors
            // Instead, orphan the entries and let them be recreated when the new layout is applied
            for (const [seriesId, entry] of refs.dataSeriesStore) {
              if (entry.paneId === paneId) {
                // Just orphan the entry - it will be recreated with new DataSeries when the new pane is ready
                entry.paneId = undefined;
                // Mark renderableSeries as null to indicate it needs recreation
                // The DataSeries will be preserved but a new RenderableSeries will be created
                entry.renderableSeries = null as any; // Mark for recreation
         
              }
            }
            
            // Destroy the pane (this will delete the surface, but DataSeries are preserved)
            paneManager.destroyPane(paneId);
            refs.paneSurfaces.delete(paneId);
          }
        }

      } catch (error) {
        // Silently handle pane creation errors
      }
    };

    createDynamicPanes();

    // Cleanup on unmount or layout change
    return () => {
      isMounted = false;
      // Don't destroy panes here - let the layout change handler do it
    };
  }, [plotLayout, config.performance.maxAutoTicks, config.chart.separateXAxes, zoomMode, parentSurfaceReady, theme]); // Added parentSurfaceReady to trigger pane creation when parent surface is ready, theme for theme updates
  
  // Update theme for all surfaces when theme changes
  useEffect(() => {
    const paneManager = paneManagerRef.current;
    
    if (paneManager) {
      // Update theme in pane manager (this updates all dynamic panes)
      paneManager.setTheme(chartTheme);
    }
  }, [theme, chartTheme]);
  
  // Update zoom mode for all surfaces (legacy and dynamic)
  useEffect(() => {
    const refs = chartRefs.current;
    const paneManager = paneManagerRef.current;
    
    if (paneManager) {
      // Update zoom mode in pane manager (this updates all dynamic panes)
      paneManager.setZoomMode(zoomMode);
    }
    
    // Update legacy surfaces if they exist
    // Note: Legacy surfaces use simpler modifiers, but we can update them too
    // For now, legacy surfaces keep their existing modifiers (X-direction wheel zoom)
    // Dynamic panes will use the zoom mode system
  }, [zoomMode]);
  
  // Keep renderableSeries visibility in sync with UI toggles
  useEffect(() => {
    const refs = chartRefs.current;
    if (!refs.tickSurface || !refs.ohlcSurface) return;

    // Save current Y-axis ranges to preserve scaling when visibility changes
    const tickYAxis = refs.tickSurface.yAxes.get(0);
    const ohlcYAxis = refs.ohlcSurface.yAxes.get(0);
    const savedTickYRange = tickYAxis?.visibleRange ? { min: tickYAxis.visibleRange.min, max: tickYAxis.visibleRange.max } : null;
    const savedOhlcYRange = ohlcYAxis?.visibleRange ? { min: ohlcYAxis.visibleRange.min, max: ohlcYAxis.visibleRange.max } : null;

    // Update visibility for all series in unified store
    // Use suspendUpdates/resumeUpdates to prevent Y-axis auto-scaling when visibility changes
    if (refs.tickSurface) refs.tickSurface.suspendUpdates();
    if (refs.ohlcSurface) refs.ohlcSurface.suspendUpdates();
    
    // Also suspend dynamic panes
    const suspendedPanes = new Map<string, boolean>();
    for (const [paneId, paneSurface] of refs.paneSurfaces) {
      try {
        paneSurface.surface.suspendUpdates();
        suspendedPanes.set(paneId, true);
      } catch (e) {
        // Ignore
      }
    }
    
    try {
      refs.dataSeriesStore.forEach((entry, seriesId) => {
        if (entry.renderableSeries) {
          // CRITICAL: If series is in layout, make it visible by default
          const isInLayout = plotLayout?.layout.series.some(s => s.series_id === seriesId);
          if (visibleSeries) {
            entry.renderableSeries.isVisible = visibleSeries.has(seriesId) || isInLayout;
          } else {
            // If no visibleSeries set, default to visible if in layout
            entry.renderableSeries.isVisible = isInLayout !== false;
          }
          
          // Set resampling mode for all series - use configured mode
          // Resampling reduces CPU usage by rendering only visible pixels
          if (entry.renderableSeries instanceof FastLineRenderableSeries) {
            entry.renderableSeries.resamplingMode = getResamplingMode();
            entry.renderableSeries.resamplingPrecision = getResamplingPrecision();
          }
        }
      });
    } finally {
      // Restore Y-axis ranges to prevent scaling changes when visibility toggles
      if (savedTickYRange && tickYAxis) {
        tickYAxis.visibleRange = new NumberRange(savedTickYRange.min, savedTickYRange.max);
      }
      if (savedOhlcYRange && ohlcYAxis) {
        ohlcYAxis.visibleRange = new NumberRange(savedOhlcYRange.min, savedOhlcYRange.max);
      }
      
      // Resume updates and invalidate - Y-axis range is preserved
      if (refs.tickSurface) refs.tickSurface.resumeUpdates();
      if (refs.ohlcSurface) refs.ohlcSurface.resumeUpdates();
      
      // Resume and invalidate dynamic panes
      for (const [paneId, paneSurface] of refs.paneSurfaces) {
        if (suspendedPanes.get(paneId)) {
          try {
            paneSurface.surface.resumeUpdates();
            paneSurface.surface.invalidateElement();
          } catch (e) {
            // Ignore
          }
        }
      }
      
      // Invalidate to show visibility changes, but Y-axis range is already preserved
      requestAnimationFrame(() => {
        refs.tickSurface?.invalidateElement();
        refs.ohlcSurface?.invalidateElement();
      });
    }
  }, [visibleSeries]);

  // SIMPLIFIED: Removed complex caching refs - direct append pattern like new-index.html

  // CHUNKED batch processing to prevent UI freezes
  // Processes samples in smaller chunks, yielding to browser between chunks
  // Now config-driven via ui-config.json performance.batchSize
  const getChunkSize = useCallback(() => config?.performance?.batchSize ?? 5000, [config]);
  const getMaxBatchesPerFrame = useCallback(() => config?.uiDrain?.maxBatchesPerFrame ?? 16, [config]);
  const getUpdateInterval = useCallback(() => config?.performance?.updateIntervalMs ?? 16, [config]);
  
  const processingQueueRef = useRef<Sample[]>([]);
  const isProcessingRef = useRef(false);
  const batchCountRef = useRef(0);
  
  // Buffer for samples that were skipped because series didn't exist yet
  // These will be reprocessed after series are created
  const skippedSamplesBufferRef = useRef<Sample[]>([]);
  const MAX_SKIPPED_BUFFER = 100000; // Keep up to 100k skipped samples for reprocessing
  
  // Process a single chunk of samples
  const processChunk = useCallback((samples: Sample[]) => {
    const refs = chartRefs.current;
    
    // We ALWAYS append incoming samples to the sharedDataSeriesPool, even during layout transitions.
    // Surfaces/panes may temporarily not exist while switching layouts; rendering updates are optional,
    // but data collection must never pause.
    const hasDynamicPanes = !!plotLayout && refs.paneSurfaces.size > 0;
    const hasLegacySurfaces = !!refs.tickSurface || !!refs.ohlcSurface;
    const hasAnySurfaces = hasDynamicPanes || hasLegacySurfaces;
    
    // Don't process if overview is being cleaned up
    if (isCleaningUpOverviewRef.current) {
      return;
    }
    
    if (samples.length === 0) return;

    let latestTime = lastDataTimeRef.current;
    const samplesLength = samples.length;
    
    // Track which panes have received data (for waiting overlay updates)
    const panesWithData = new Set<string>();
    
    // OPTIMIZATION: Group samples by series_id first, then use appendRange()
    // This reduces WASM boundary crossing from N calls to M calls (M = unique series)
    // Much more efficient than individual append() calls
    // CRITICAL: Store dataSeries directly, not entry reference - ensures data persists during layout transitions
    const xyBatches = new Map<string, { x: number[], y: number[], dataSeries: XyDataSeries }>();
    const ohlcBatches = new Map<string, { x: number[], o: number[], h: number[], l: number[], c: number[], dataSeries: OhlcDataSeries }>();
    
    // First pass: group samples by series
    for (let i = 0; i < samplesLength; i++) {
      const sample = samples[i];
      const { series_id, t_ms, t_ns, payload } = sample;
      
      // CRITICAL: Convert milliseconds + nanoseconds to seconds for SciChart DateTimeNumericAxis
      // SciChart expects Unix timestamps in SECONDS, not milliseconds
      const t_sec = toSecondsPrecise(t_ms, t_ns);
      
      if (t_ms > latestTime) {
        latestTime = t_ms; // Keep latestTime in ms for internal tracking
      }

      // CRITICAL: Always try to get dataSeries from sharedDataSeriesPool FIRST
      // This ensures data is NEVER lost during layout transitions, even if refs.dataSeriesStore
      // is being rebuilt. The pool persists across all layout changes.
      
      // Determine series type for pool lookup
      const isOhlcSeries = series_id.includes(':ohlc_');
      const seriesType: 'xy' | 'ohlc' = isOhlcSeries ? 'ohlc' : 'xy';
      
      // Get or create from the persistent pool - this NEVER loses data
      let pooledEntry = sharedDataSeriesPool.get(series_id);
      if (!pooledEntry && sharedDataSeriesPool.isInitialized()) {
        // Create in pool if it doesn't exist (pool persists across layout changes)
        pooledEntry = sharedDataSeriesPool.getOrCreate(series_id, seriesType);
      }
      
      // Also check refs.dataSeriesStore for paneId tracking (but don't require it for data append)
      const storeEntry = refs.dataSeriesStore.get(series_id);
      
      // If we don't have a pooled DataSeries yet (most commonly because the pool isn't initialized
      // during early startup), we MUST buffer samples so that server preloaded history is not lost.
      // This is required for cases like:
      //   --init-preload-samples 1000
      //   --live-start-delay-sec 60
      // where we expect to see plots immediately after init_complete.
      if (!pooledEntry) {
        // Buffer ALL samples (bounded) so history can be replayed once pool/surfaces are ready.
        // We intentionally do NOT gate this on layout membership; the product requirement is to
        // keep collecting data even when layouts are missing/mismatched.
        if (skippedSamplesBufferRef.current.length < MAX_SKIPPED_BUFFER) {
          skippedSamplesBufferRef.current.push(sample);
        } else {
          skippedSamplesBufferRef.current.shift();
          skippedSamplesBufferRef.current.push(sample);
        }

        // DEBUG: Log missing series (throttled)
        if (i === 0) {
          const bufferedCount = skippedSamplesBufferRef.current.length;
          console.warn(`[MultiPaneChart] ⚠️ Pool not ready for series, buffering: ${series_id} (${bufferedCount} buffered)`);
        }
        continue;
      }
      
      // Use the dataSeries from the pool (guaranteed to persist across layout changes)
      const dataSeries = pooledEntry.dataSeries;
      
      // Track pane for overlay update (use storeEntry if available, but don't require it)
      if (storeEntry?.paneId) {
        panesWithData.add(storeEntry.paneId);
      }

      // FAST TYPE DETECTION using string includes (already computed above)
      if (isOhlcSeries) {
        const o = payload.o as number;
        const h = payload.h as number;
        const l = payload.l as number;
        const c = payload.c as number;
        if (typeof o === 'number' && typeof h === 'number' && 
            typeof l === 'number' && typeof c === 'number') {
          let batch = ohlcBatches.get(series_id);
          if (!batch) {
            // Store dataSeries directly from pool, not entry reference
            batch = { x: [], o: [], h: [], l: [], c: [], dataSeries: dataSeries as OhlcDataSeries };
            ohlcBatches.set(series_id, batch);
          }
          batch.x.push(t_sec); // Use seconds for SciChart
          batch.o.push(o);
          batch.h.push(h);
          batch.l.push(l);
          batch.c.push(c);
        }
      } else {
        // CRITICAL: Skip strategy markers and signals from xy batch accumulation.
        // They are processed separately in the third pass using scatter series
        // and should NOT consume pool memory as regular xy data.
        if (series_id.includes(':markers') || series_id.includes(':signals')) {
          continue;
        }
        
        let value: number | undefined;
        
        if (series_id.includes(':ticks')) {
          value = payload.price as number;
        } else if (series_id.includes(':pnl') || series_id.includes(':sma_') || 
                   series_id.includes(':ema_') || series_id.includes(':vwap')) {
          value = payload.value as number;
        } else if (series_id.includes(':strategy:')) {
          value = (payload.price as number) || (payload.value as number);
        } else {
          value = payload.value as number ?? payload.price as number;
        }
        
        if (typeof value === 'number' && !isNaN(value)) {
          let batch = xyBatches.get(series_id);
          if (!batch) {
            // Store dataSeries directly from pool, not entry reference
            batch = { x: [], y: [], dataSeries: dataSeries as XyDataSeries };
            xyBatches.set(series_id, batch);
          }
          batch.x.push(t_sec); // Use seconds for SciChart
          batch.y.push(value);
        }
      }
    }
    
    // CRITICAL: Suspend all surfaces before batch append to prevent render-loop blocking
    // Without this, each appendRange triggers a redraw causing UI freezes during heavy data ingestion
    const suspendedSurfaces = new Set<SciChartSurface>();
    
    // Suspend legacy surfaces
    if (refs.tickSurface) {
      try { refs.tickSurface.suspendUpdates(); suspendedSurfaces.add(refs.tickSurface); } catch (e) {}
    }
    if (refs.ohlcSurface) {
      try { refs.ohlcSurface.suspendUpdates(); suspendedSurfaces.add(refs.ohlcSurface); } catch (e) {}
    }
    
    // Suspend dynamic pane surfaces
    for (const [, paneSurface] of refs.paneSurfaces) {
      try { paneSurface.surface.suspendUpdates(); suspendedSurfaces.add(paneSurface.surface); } catch (e) {}
    }
    
    try {
      // Second pass: appendRange for each series (much fewer WASM calls)
      // CRITICAL: Use dataSeries directly from pool - this persists across layout changes
      for (const [seriesId, batch] of xyBatches) {
        try {
          // CRITICAL: Check WASM health before appending to prevent cascading failures
          if (!chartLogger.isWasmHealthy()) {
            chartLogger.warn('DataAppend', `Skipping XY append for ${seriesId} - WASM unhealthy`);
            continue;
          }
          // Enforce monotonic, finite X/Y before appending. The shared pool creates DataSeries
          // with dataIsSortedInX=true, so out-of-order data can cause undefined behavior.
          let prevX = lastXBySeriesRef.current.get(seriesId);
          if (prevX === undefined) {
            // Initialize prevX from existing data (if any). This avoids allowing out-of-order
            // appends after layout changes where we may have lost local lastX tracking.
            try {
              const existingCount = batch.dataSeries.count();
              if (existingCount > 0) {
                const nativeX = batch.dataSeries.getNativeXValues();
                if (nativeX && nativeX.size() > 0) {
                  const lastVal = nativeX.get(existingCount - 1);
                  if (Number.isFinite(lastVal)) {
                    prevX = lastVal;
                    lastXBySeriesRef.current.set(seriesId, lastVal);
                  }
                }
              }
            } catch {
              // Ignore - if WASM is unstable this might throw; we'll let append fail and be logged.
            }
          }

          const sanitized = sanitizeSortedXyBatch(seriesId, batch.x, batch.y, prevX);

          // Breadcrumb keeps a lightweight trace of recent operations for post-mortem debugging
          chartLogger.breadcrumb('AppendRange', `XY ${seriesId}`, sanitized.stats);

          // Throttle noisy validation warnings
          if (sanitized.stats.droppedNonFinite > 0 || sanitized.stats.droppedOutOfOrder > 0) {
            const nowMs = Date.now();
            const lastWarn = lastBatchWarnTimeRef.current.get(seriesId) ?? 0;
            if (nowMs - lastWarn > 5000) {
              lastBatchWarnTimeRef.current.set(seriesId, nowMs);
              chartLogger.warn('DataValidation', `Dropped invalid XY points for ${seriesId}`, sanitized.stats);
            }
          }

          if (sanitized.x.length === 0) {
            continue;
          }

          batch.dataSeries.appendRange(sanitized.x, sanitized.y);

          if (sanitized.nextX !== undefined && Number.isFinite(sanitized.nextX)) {
            lastXBySeriesRef.current.set(seriesId, sanitized.nextX);
          }
          // Mark series as having data
          if (batch.x.length > 0) {
            refs.seriesHasData.set(seriesId, true);
            // Also mark in pool
            sharedDataSeriesPool.markDataReceived(seriesId);
          }
        } catch (e) {
          // Log WASM errors with full context for debugging
          const errorStr = String((e as any)?.message || e);
          if (errorStr.includes('Aborted') || errorStr.includes('memory') || errorStr.includes('wasm')) {
            let seriesCount: number | undefined;
            try {
              seriesCount = batch.dataSeries.count();
            } catch {
              seriesCount = undefined;
            }
            chartLogger.critical('DataAppend', `WASM error appending XY data to ${seriesId}`, e, {
              batchSize: batch.x.length,
              seriesCount,
              lastBreadcrumbs: chartLogger.getBreadcrumbs().slice(-20),
            });
          } else {
            chartLogger.error('DataAppend', `Error appending XY data to ${seriesId}`, e);
          }
        }
      }
      
      for (const [seriesId, batch] of ohlcBatches) {
        try {
          // CRITICAL: Check WASM health before appending
          if (!chartLogger.isWasmHealthy()) {
            chartLogger.warn('DataAppend', `Skipping OHLC append for ${seriesId} - WASM unhealthy`);
            continue;
          }
          // Enforce monotonic, finite X/OHLC before appending.
          let prevX = lastXBySeriesRef.current.get(seriesId);
          if (prevX === undefined) {
            try {
              const existingCount = batch.dataSeries.count();
              if (existingCount > 0) {
                const nativeX = batch.dataSeries.getNativeXValues();
                if (nativeX && nativeX.size() > 0) {
                  const lastVal = nativeX.get(existingCount - 1);
                  if (Number.isFinite(lastVal)) {
                    prevX = lastVal;
                    lastXBySeriesRef.current.set(seriesId, lastVal);
                  }
                }
              }
            } catch {
              // Ignore
            }
          }

          const sanitized = sanitizeSortedOhlcBatch(
            seriesId,
            batch.x,
            batch.o,
            batch.h,
            batch.l,
            batch.c,
            prevX
          );

          chartLogger.breadcrumb('AppendRange', `OHLC ${seriesId}`, sanitized.stats);

          if (sanitized.stats.droppedNonFinite > 0 || sanitized.stats.droppedOutOfOrder > 0) {
            const nowMs = Date.now();
            const lastWarn = lastBatchWarnTimeRef.current.get(seriesId) ?? 0;
            if (nowMs - lastWarn > 5000) {
              lastBatchWarnTimeRef.current.set(seriesId, nowMs);
              chartLogger.warn('DataValidation', `Dropped invalid OHLC points for ${seriesId}`, sanitized.stats);
            }
          }

          if (sanitized.x.length === 0) {
            continue;
          }

          batch.dataSeries.appendRange(sanitized.x, sanitized.o, sanitized.h, sanitized.l, sanitized.c);

          if (sanitized.nextX !== undefined && Number.isFinite(sanitized.nextX)) {
            lastXBySeriesRef.current.set(seriesId, sanitized.nextX);
          }
          // Mark series as having data
          if (batch.x.length > 0) {
            refs.seriesHasData.set(seriesId, true);
            // Also mark in pool
            sharedDataSeriesPool.markDataReceived(seriesId);
          }
        } catch (e) {
          // Log WASM errors with full context for debugging
          const errorStr = String((e as any)?.message || e);
          if (errorStr.includes('Aborted') || errorStr.includes('memory') || errorStr.includes('wasm')) {
            let seriesCount: number | undefined;
            try {
              seriesCount = batch.dataSeries.count();
            } catch {
              seriesCount = undefined;
            }
            chartLogger.critical('DataAppend', `WASM error appending OHLC data to ${seriesId}`, e, {
              batchSize: batch.x.length,
              seriesCount,
              lastBreadcrumbs: chartLogger.getBreadcrumbs().slice(-20),
            });
          } else {
            chartLogger.error('DataAppend', `Error appending OHLC data to ${seriesId}`, e);
          }
        }
      }
    } finally {
      // Resume all surfaces - this triggers a single batched redraw instead of N redraws
      for (const surface of suspendedSurfaces) {
        try { 
          // CRITICAL: Validate surface before resuming
          if (!(surface as any).isDeleted) {
            surface.resumeUpdates(); 
          }
        } catch (e) {
          chartLogger.error('SurfaceResume', 'Error resuming surface updates', e);
        }
      }
      
      // Update waiting annotations after data is appended
      // Wrap in try-catch to prevent annotation errors from crashing data processing
      try {
        updateWaitingAnnotations();
      } catch (e) {
        chartLogger.warn('Annotations', 'Error updating waiting annotations', e);
      }
    }
    
    // Update standalone minimap if it exists (for multi_surface layouts)
    const minimapDataSeries = (refs as any).minimapDataSeries as XyDataSeries | null;
    const minimapSourceSeriesId = (refs as any).minimapSourceSeriesId as string | null;
    if (minimapDataSeries && minimapSourceSeriesId) {
      // Get the batch for the minimap source series
      const minimapBatch = xyBatches.get(minimapSourceSeriesId);
      if (minimapBatch && minimapBatch.x.length > 0) {
        try {
          const minimapSurface = (refs as any).minimapSurface as SciChartSurface | null;
          if (minimapSurface) {
            minimapSurface.suspendUpdates();
            try {
              // CRITICAL: Validate arrays before appending to avoid memory errors
              if (minimapBatch.x.length === minimapBatch.y.length && minimapBatch.x.length > 0) {
                // Validate all values are finite
                const validX: number[] = [];
                const validY: number[] = [];
                for (let i = 0; i < minimapBatch.x.length; i++) {
                  const x = minimapBatch.x[i];
                  const y = minimapBatch.y[i];
                  if (isFinite(x) && isFinite(y)) {
                    validX.push(x);
                    validY.push(y);
                  }
                }
                if (validX.length > 0) {
                  // Enforce monotonic order for the minimap data series as well.
                  // Minimap XyDataSeries is created with isSorted=true.
                  const minimapKey = `__minimap__:${minimapSourceSeriesId}`;
                  let prevX = lastXBySeriesRef.current.get(minimapKey);
                  if (prevX === undefined) {
                    try {
                      const existingCount = minimapDataSeries.count();
                      if (existingCount > 0) {
                        const nativeX = minimapDataSeries.getNativeXValues();
                        if (nativeX && nativeX.size() > 0) {
                          const lastVal = nativeX.get(existingCount - 1);
                          if (Number.isFinite(lastVal)) {
                            prevX = lastVal;
                            lastXBySeriesRef.current.set(minimapKey, lastVal);
                          }
                        }
                      }
                    } catch {
                      // ignore
                    }
                  }

                  const sanitized = sanitizeSortedXyBatch(minimapKey, validX, validY, prevX);
                  chartLogger.breadcrumb('AppendRange', `MINIMAP ${minimapSourceSeriesId}`, sanitized.stats);

                  if (sanitized.stats.droppedNonFinite > 0 || sanitized.stats.droppedOutOfOrder > 0) {
                    const nowMs = Date.now();
                    const lastWarn = lastBatchWarnTimeRef.current.get(minimapKey) ?? 0;
                    if (nowMs - lastWarn > 5000) {
                      lastBatchWarnTimeRef.current.set(minimapKey, nowMs);
                      chartLogger.warn('DataValidation', `Dropped invalid MINIMAP points for ${minimapSourceSeriesId}`, sanitized.stats);
                    }
                  }

                  if (sanitized.x.length > 0) {
                    minimapDataSeries.appendRange(sanitized.x, sanitized.y);
                    if (sanitized.nextX !== undefined && Number.isFinite(sanitized.nextX)) {
                      lastXBySeriesRef.current.set(minimapKey, sanitized.nextX);
                    }
                  }
                  
                  // CRITICAL: Update minimap X-axis to show full data range after new data arrives
                  // The minimap should always show all data, not just the current selection
                  // The range indicator (OverviewRangeSelectionModifier) will stay where user put it
                  const minimapXAxis = (refs as any).minimapXAxis as DateTimeNumericAxis | null;
                  if (minimapXAxis && minimapDataSeries.count() > 0) {
                    try {
                      const fullDataRange = minimapDataSeries.getXRange();
                      if (fullDataRange) {
                        // ALWAYS update minimap X-axis to show full data range (no blocking)
                        // This ensures minimap always displays all available data
                        const currentRange = minimapXAxis.visibleRange;
                        const needsUpdate = !currentRange || 
                            fullDataRange.min < currentRange.min ||
                            fullDataRange.max > currentRange.max;
                        
                        if (needsUpdate) {
                          // CRITICAL: Batch updates as suggested by SciChart support
                          minimapSurface.suspendUpdates();
                          
                          // Ensure autoRange and growBy are set to prevent any automatic changes
                          (minimapXAxis as any).autoRange = EAutoRange.Never;
                          minimapXAxis.growBy = new NumberRange(0, 0);
                          minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);
                          
                          // Resume updates and invalidate to force overlay recalculation
                          // This ensures the OverviewRangeSelectionModifier recalculates the overlay
                          // to cover all unselected areas (from axis.min to selectedRange.min and 
                          // from selectedRange.max to axis.max)
                          minimapSurface.resumeUpdates();
                          minimapSurface.invalidateElement();
                        }
                      }
                    } catch (e) {
                      chartLogger.warn('Minimap', 'Error updating minimap X-axis range', e);
                    }
                  }
                }
              }
            } catch (e) {
              chartLogger.error('Minimap', 'Error updating minimap data', e, {
                sourceSeriesId: minimapSourceSeriesId,
                lastBreadcrumbs: chartLogger.getBreadcrumbs().slice(-20),
              });
              // Don't throw - just log the error
            } finally {
              minimapSurface.resumeUpdates();
            }
          }
        } catch (e) {
          chartLogger.error('Minimap', 'Error accessing minimap surface', e, {
            sourceSeriesId: minimapSourceSeriesId,
          });
        }
      }
    } else if (minimapSourceSeriesId && !minimapDataSeries && overviewNeedsRefreshSetterRef.current) {
      // Minimap doesn't exist yet, but we have data for the source series
      // Trigger a refresh to create the minimap
      // This happens when data arrives before minimap is created
      const sourceSeriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
      if (sourceSeriesEntry?.dataSeries && sourceSeriesEntry.dataSeries.count() > 0) {
        // Source series now has data - trigger minimap creation by updating overviewNeedsRefresh state
        // The useEffect will detect this and create the minimap
        console.log(`[MultiPaneChart] Triggering minimap creation - source series ${minimapSourceSeriesId} now has ${sourceSeriesEntry.dataSeries.count()} data points`);
        overviewNeedsRefreshSetterRef.current(Date.now());
      }
    }
    
    // Third pass: Strategy markers using scatter series with appendRange (efficient batch updates)
    // REQUIREMENT: Strategy markers must appear initially along with other series
    // NEW: Per-strategy series assignment - only plot explicitly assigned strategy series
    if (plotLayout && refs.paneSurfaces.size > 0) {
      // Create empty batches for accumulating markers per pane
      const paneMarkerBatches = new Map<string, Map<MarkerSeriesType, { x: number[], y: number[] }>>();
      
      // Initialize batches for panes that will receive markers
      // We'll add panes dynamically as we encounter assigned strategy series
      
      // Accumulate markers into batches
      for (let i = 0; i < samplesLength; i++) {
        const sample = samples[i];
        const { series_id, t_ms, t_ns, payload } = sample;
        
        // Only process strategy markers/signals
        if (!series_id.includes(':strategy:')) continue;
        if (!series_id.includes(':markers') && !series_id.includes(':signals')) continue;
        
        // Store in persistent history for replay after layout reload
        // Cap at 100K to prevent memory issues
        if (refs.markerSampleHistory.length < 100000) {
          refs.markerSampleHistory.push({ series_id, t_ms, t_ns, payload: payload as Record<string, unknown> });
        }
        
        // Check if this strategy series is explicitly assigned in the layout
        const strategyAssignment = plotLayout.getStrategySeriesAssignment(series_id);
        const allAssignments = plotLayout.getAllStrategySeriesAssignments(series_id);
        
        let targetPanes: string[] = [];
        
        if (allAssignments.length > 0) {
          // Explicit assignment(s) - route to ALL assigned panes
          targetPanes = allAssignments
            .map(sa => sa.pane)
            .filter(paneId => refs.paneSurfaces.has(paneId));
        } else {
          // Legacy fallback
          targetPanes = Array.from(plotLayout.strategyMarkerPanes);
        }
        
        // Skip if no target panes
        if (targetPanes.length === 0) {
          if (i === 0) console.warn(`[Markers] No target panes for ${series_id}. Assignment found: ${!!strategyAssignment}, legacyPanes: ${plotLayout.strategyMarkerPanes.size}`);
          continue;
        }
        
        // Get marker timestamp in seconds with nanosecond precision (for X-axis)
        const markerXSeconds = toSecondsPrecise(t_ms, t_ns);
        
        // Add to batches for target panes - resolve yvalue PER PANE assignment
        // Each pane assignment may have a different yvalue source series
        for (const paneId of targetPanes) {
          // Find the specific assignment for THIS pane
          const paneAssignment = allAssignments.find(sa => sa.pane === paneId) || strategyAssignment;
          
          // Determine y-value per-pane: use this pane's yvalue series lookup OR payload price as fallback
          let yValue: number | null = null;
          
          if (paneAssignment?.yvalue) {
            const ySourceSeriesId = paneAssignment.yvalue;
            
            let ySourceDataSeries: XyDataSeries | null = null;
            const ySourceEntry = refs.dataSeriesStore.get(ySourceSeriesId);
            if (ySourceEntry?.dataSeries && ySourceEntry.dataSeries.count() > 0) {
              ySourceDataSeries = ySourceEntry.dataSeries as XyDataSeries;
            } else {
              const poolEntry = sharedDataSeriesPool.get(ySourceSeriesId);
              if (poolEntry?.dataSeries && poolEntry.dataSeries.count() > 0) {
                ySourceDataSeries = poolEntry.dataSeries as XyDataSeries;
              }
            }
            
            if (ySourceDataSeries && ySourceDataSeries.count() > 0) {
              // Use linear interpolation to place markers exactly on the line
              const interpolated = interpolateYValue(ySourceDataSeries, markerXSeconds);
              if (interpolated !== null) {
                yValue = interpolated;
              }
            } else {
              if (i === 0) console.warn(`[Markers] yvalue source "${ySourceSeriesId}" has no data yet`);
            }
          }
          
          // Fallback to payload price
          if (yValue === null) {
            yValue = (payload.price as number) || (payload.value as number) || 0;
          }
          
          // Skip markers with no valid y-value (0) unless yvalue lookup is configured
          if (yValue === 0 && !paneAssignment?.yvalue) continue;
          
          // Log first few markers for debugging
          if (i < 3) {
            console.log(`[Markers] ${series_id} t=${t_ms} y=${yValue} pane=${paneId} yvalueSrc=${paneAssignment?.yvalue || 'none'}`);
          }
          
          // Parse marker data with the resolved y-value for THIS pane
          const markerData = parseMarkerFromSample({
            t_ms,
            v: yValue,
            side: payload.side as string,
            tag: payload.tag as string,
            type: payload.type as string,
            direction: payload.direction as string,
            label: payload.label as string,
          }, series_id);
          
          const markerType = getMarkerSeriesType(markerData);
          
          // Initialize batch for this pane if not exists
          if (!paneMarkerBatches.has(paneId)) {
            paneMarkerBatches.set(paneId, createEmptyMarkerBatches());
          }
          
          const typeBatches = paneMarkerBatches.get(paneId);
          if (typeBatches) {
            const batch = typeBatches.get(markerType);
            if (batch) {
              batch.x.push(markerData.x);
              batch.y.push(markerData.y);
            }
          }
        }
      }
      
      // Use appendRange to efficiently add markers to scatter series
      for (const [paneId, typeBatches] of paneMarkerBatches) {
        const paneSurface = refs.paneSurfaces.get(paneId);
        if (!paneSurface || !paneSurface.surface) continue;
        
        // Get scatter series for this pane (already created during pane initialization)
        let scatterSeriesMap = refs.markerScatterSeries.get(paneId);
        
        // If scatter series don't exist for this pane yet, create them on-demand
        // This is needed when strategy series is explicitly assigned to a pane that
        // doesn't have scatter series pre-created (only legacy global config panes get them)
        if (!scatterSeriesMap && paneSurface.wasm) {
          const capacity = getSeriesCapacity();
          // Find the strategy assignment for this pane to get markerStyle
          const paneStrategyAssignment = plotLayout ? Array.from(plotLayout.strategySeriesMap.values()).flat().find(
            sa => sa.pane === paneId && (sa.type === 'strategy_markers' || sa.type === 'strategy_signals')
          ) : undefined;
          scatterSeriesMap = createAllMarkerScatterSeries(paneSurface.wasm, capacity, paneId, paneStrategyAssignment?.markerStyle);
          refs.markerScatterSeries.set(paneId, scatterSeriesMap);
          
          // Add scatter series to surface
          for (const [, group] of scatterSeriesMap) {
            paneSurface.surface.renderableSeries.add(group.renderableSeries);
          }
          console.log(`[MultiPaneChart] Created scatter series on-demand for explicitly assigned markers on pane: ${paneId}`);
        }
        
        if (!scatterSeriesMap) continue;
        
        // Append data to each scatter series type - simple fast update, no creation
        for (const [markerType, batch] of typeBatches) {
          if (batch.x.length === 0) continue;
          
          const scatterGroup = scatterSeriesMap.get(markerType);
          if (scatterGroup) {
            scatterGroup.dataSeries.appendRange(batch.x, batch.y);
          }
        }
      }
    }

    // Update last data time
    lastDataTimeRef.current = latestTime;
    onDataClockUpdate?.(latestTime);
    
    // Update waiting overlays for panes that received data (batch DOM update)
    // CRITICAL: Also track if this is the first time data appears for any pane
    let firstDataReceived = false;
    if (panesWithData.size > 0) {
      requestAnimationFrame(() => {
        for (const paneId of panesWithData) {
          const paneSurface = refs.paneSurfaces.get(paneId);
          if (paneSurface) {
            // Check if this is the first time data is received for this pane
            if (!paneSurface.hasData) {
              firstDataReceived = true;
              // CRITICAL: Mark that at least one pane has data - enables auto-scroll
              anyPaneHasDataRef.current = true;
            }
            paneSurface.hasData = true;
            paneSurface.waitingForData = false;
          }
          updatePaneWaitingOverlay(refs, layoutManager, paneId, plotLayout);
        }
        
        // CRITICAL: If this is the first time data appears, force a full refresh
        // This ensures data appears on full reload (not just hot reload)
        if (firstDataReceived) {
          console.log(`[MultiPaneChart] 🎯 First data received, enabling auto-scroll and forcing chart refresh`);
          setTimeout(() => {
            const refs = chartRefs.current;
            // Invalidate all surfaces to force a visual refresh
            if (refs.tickSurface) {
              refs.tickSurface.invalidateElement();
            }
            if (refs.ohlcSurface) {
              refs.ohlcSurface.invalidateElement();
            }
            // Invalidate all dynamic panes
            for (const [paneId, paneSurface] of refs.paneSurfaces) {
              try {
                paneSurface.surface.invalidateElement();
                // Force X-axis to update its range
                if (paneSurface.xAxis) {
                  const xRange = paneSurface.xAxis.visibleRange;
                  if (xRange) {
                    // Trigger range update by setting it to itself
                    paneSurface.xAxis.visibleRange = xRange;
                  }
                }
                // Force Y-axis to update its range
                if (paneSurface.yAxis) {
                  const yRange = paneSurface.yAxis.visibleRange;
                  if (yRange) {
                    paneSurface.yAxis.visibleRange = yRange;
                  }
                }
              } catch (e) {
                // Ignore errors during invalidation
              }
            }
          }, 50); // Small delay to ensure data is fully processed
        }
      });
    }

    // CRITICAL: Skip ALL plot updates (auto-scroll, Y-axis scaling) until first data arrives
    // This ensures "Waiting for Data..." state is not decoupled from plot updates
    if (!anyPaneHasDataRef.current) {
      return; // No data yet - don't auto-scroll or update anything
    }

    // Skip auto-scroll during range restoration
    if (isRestoringRangeRef.current) {
      return;
    }
    
    // Auto-scroll logic (only in live mode with sticky minimap)
    // CRITICAL: If a time window preset is selected, continuously update it to show the last X minutes from latest data
    // This ensures the window always shows the most recent X minutes, even as new data arrives
    const isLive = feedStage === 'live';
    const hasSelectedWindow = selectedWindowMinutesRef.current !== null;
    
    // DEBUG: Log all flags that affect auto-scroll
    const debugFlags = {
      isLiveRef: isLiveRef.current,
      userInteractedRef: userInteractedRef.current,
      settingTimeWindowRef: settingTimeWindowRef.current,
      minimapStickyRef: minimapStickyRef.current,
      hasSelectedWindow,
      selectedWindowMinutes: selectedWindowMinutesRef.current,
      isLive,
      feedStage,
      latestTime,
    };
    
    // Auto-scroll is enabled if:
    // 1. In live mode AND
    // 2. User hasn't explicitly paused (userInteractedRef) AND
    // 3. We're not currently setting a time window (to prevent conflicts) AND
    // 4. Either: minimap is sticky OR a time window is selected (which should auto-update in live mode)
    // Note: When a time window is selected, we want it to continuously update in live mode
    // unless the user has explicitly paused (userInteractedRef = true)
    // CRITICAL: Don't block auto-scroll if settingTimeWindowRef is true for too long - use a shorter timeout
    // CRITICAL: For time windows, check isLiveRef.current (not just feedStage) to allow auto-scroll
    // even if feedStage hasn't reached 'live' yet, as long as user explicitly enabled live mode
    const autoScrollEnabled = isLiveRef.current && !userInteractedRef.current && !settingTimeWindowRef.current &&
      (minimapStickyRef.current || (hasSelectedWindow && (isLive || isLiveRef.current)));
    
    
    // CRITICAL: Allow auto-scroll if either feedStage is 'live' OR user explicitly enabled live mode
    // This ensures auto-scroll works immediately when live mode is toggled, even if feedStage hasn't reached 'live' yet
    const shouldRunAutoScroll = (isLive || isLiveRef.current) && autoScrollEnabled && latestTime > 0;
    
    // Notify parent when auto-scroll state changes (for HUD sync)
    if (onAutoScrollChange && prevAutoScrollStateRef.current !== shouldRunAutoScroll) {
      prevAutoScrollStateRef.current = shouldRunAutoScroll;
      onAutoScrollChange(shouldRunAutoScroll);
    }
    
    
    if (shouldRunAutoScroll) {
      const now = performance.now();
      
      // CRITICAL: For time windows, use latestTime directly (much faster than iterating all series)
      // latestTime comes in as milliseconds, convert to seconds for range calculations
      const latestTimeSec = latestTime / 1000;
      const X_SCROLL_THRESHOLD = 0.1; // Small threshold (0.1 seconds) for minimap mode
      const Y_AXIS_UPDATE_INTERVAL = 1000; // Update Y-axis every second
      
      let newRange: NumberRange;
      
      // Handle "Entire Session" mode - expand to show all data from min to max
      if (sessionModeRef.current) {
        // Calculate actual data min/max from all series
        let globalDataMin = Infinity;
        let globalDataMax = -Infinity;
        
        for (const [seriesId, entry] of refs.dataSeriesStore) {
          if (entry.dataSeries && entry.dataSeries.count() > 0) {
            try {
              const xRange = entry.dataSeries.getXRange();
              if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
                globalDataMin = Math.min(globalDataMin, xRange.min);
                globalDataMax = Math.max(globalDataMax, xRange.max);
              }
            } catch (e) {
              // Continue with other series
            }
          }
        }
        
        // If we found valid data, create range from min to max
        if (isFinite(globalDataMin) && isFinite(globalDataMax) && globalDataMax > globalDataMin) {
          const dataRange = globalDataMax - globalDataMin;
          const paddingSec = dataRange * 0.02; // 2% padding
          newRange = new NumberRange(globalDataMin - paddingSec, globalDataMax + paddingSec);
        } else {
          // Fallback to latestTimeSec with default window
          const windowSec = 300; // 5 minutes default
          newRange = new NumberRange(latestTimeSec - windowSec, latestTimeSec + 10);
        }
      } else {
        // CRITICAL: If a time window preset is selected, use that window size
        // Otherwise, use the stored minimap window width (from manual drag)
        // NOTE: All range calculations are in SECONDS for SciChart DateTimeNumericAxis
        let windowSec: number;
        if (hasSelectedWindow && selectedWindowMinutesRef.current !== null) {
          // Use the selected window size (convert minutes to seconds)
          windowSec = selectedWindowMinutesRef.current * 60;
        } else {
          // Use the stored minimap window width (convert from ms to seconds)
          windowSec = minimapTimeWindowRef.current / 1000;
        }
        
        // CRITICAL: Always use latestTimeSec directly for smooth scrolling
        const actualDataMax = latestTimeSec; // In seconds
        
        // CRITICAL: Calculate new range with right edge at latest data (sticky behavior)
        // All values are in SECONDS for SciChart DateTimeNumericAxis
        const paddingSec = windowSec * 0.02; // 2% padding on right edge
        newRange = new NumberRange(actualDataMax - windowSec, actualDataMax + paddingSec);
      }

      // Sync all main chart X-axes (linked panes)
      (refs as any).mainChartSyncInProgress = true; // Block minimap-to-main sync during auto-scroll
      try {
        for (const [paneId, paneSurface] of refs.paneSurfaces) {
          if (paneSurface?.xAxis) {
            // Always update in live/sticky mode for smooth scrolling
            // Removed threshold check that was causing choppy scrolling when minimap was used
            if ((paneSurface.xAxis as any).autoRange !== undefined) {
              (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
            }
            try {
              paneSurface.xAxis.growBy = new NumberRange(0, 0);
            } catch (e) {
              (paneSurface.xAxis as any).growBy = new NumberRange(0, 0);
            }
            paneSurface.xAxis.visibleRange = newRange;
          }
        }

        // Also sync legacy surfaces
        if (refs.tickSurface?.xAxes.get(0)) {
          if (hasSelectedWindow) {
            const axis = refs.tickSurface.xAxes.get(0);
            if ((axis as any).autoRange !== undefined) {
              (axis as any).autoRange = EAutoRange.Never;
            }
            if (axis.growBy) {
              axis.growBy = new NumberRange(0, 0);
            }
          }
          refs.tickSurface.xAxes.get(0).visibleRange = newRange;
        }
        if (refs.ohlcSurface?.xAxes.get(0)) {
          if (hasSelectedWindow) {
            const axis = refs.ohlcSurface.xAxes.get(0);
            if ((axis as any).autoRange !== undefined) {
              (axis as any).autoRange = EAutoRange.Never;
            }
            if (axis.growBy) {
              axis.growBy = new NumberRange(0, 0);
            }
          }
          refs.ohlcSurface.xAxes.get(0).visibleRange = newRange;
        }

        // LIVE MODE: Always pin the minimap indicator's right edge to the latest timestamp
        // This ensures the indicator follows new data as it arrives when sticky/live mode is active
        // CRITICAL: Use re-entry guard to prevent triggering onSelectedAreaChanged
        const rangeSelectionModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
        const setUpdatingFlag = (refs as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
        if (rangeSelectionModifier && minimapStickyRef.current) {
          try {
            // CRITICAL: Update minimap X-axis to full data range FIRST, before updating selectedArea
            // The OverviewRangeSelectionModifier calculates overlay based on axis.visibleRange,
            // so the axis MUST show full data range BEFORE the modifier processes the selection change
            // Following SciChart support suggestion: batch updates and add delay between axis range and selectedArea
            const minimapXAxis = (refs as any).minimapXAxis as DateTimeNumericAxis | null;
            const minimapSurface = (refs as any).minimapSurface as SciChartSurface | null;
            const minimapDataSeries = (refs as any).minimapDataSeries as XyDataSeries | null;
            
            if (minimapXAxis && minimapSurface && minimapDataSeries && minimapDataSeries.count() > 0) {
              try {
                const fullDataRange = minimapDataSeries.getXRange();
                if (fullDataRange) {
                  const currentAxisRange = minimapXAxis.visibleRange;
                  // Always update to full data range - overlay depends on this
                  if (!currentAxisRange || 
                      Math.abs(currentAxisRange.min - fullDataRange.min) > 0.1 ||
                      Math.abs(currentAxisRange.max - fullDataRange.max) > 0.1) {
                    // CRITICAL: Batch updates as suggested by SciChart support
                    minimapSurface.suspendUpdates();
                    
                    // Set these properties to prevent any automatic changes
                    (minimapXAxis as any).autoRange = EAutoRange.Never;
                    minimapXAxis.growBy = new NumberRange(0, 0);
                    minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);

                    // Resume now - don't keep the surface suspended across an async boundary.
                    minimapSurface.resumeUpdates();
                    minimapSurface.invalidateElement();

                    // Schedule selectedArea update (cancel any pending update to avoid stale refs)
                    if (minimapSelectedAreaUpdateTimeoutRef.current) {
                      clearTimeout(minimapSelectedAreaUpdateTimeoutRef.current);
                    }
                    minimapSelectedAreaUpdateTimeoutRef.current = setTimeout(() => {
                      minimapSelectedAreaUpdateTimeoutRef.current = null;
                      try {
                        const refsNow = chartRefs.current;
                        const minimapSurfaceNow = (refsNow as any).minimapSurface as SciChartSurface | null;
                        const rangeSelectionModifierNow = (refsNow as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
                        const setUpdatingFlagNow = (refsNow as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
                        const minimapXAxisNow = (refsNow as any).minimapXAxis as DateTimeNumericAxis | null;

                        if (!minimapSurfaceNow || (minimapSurfaceNow as any).isDeleted) {
                          chartLogger.warn('Minimap', 'Surface deleted before selectedArea update (with axis)');
                          return;
                        }
                        if (!rangeSelectionModifierNow || (rangeSelectionModifierNow as any).isDeleted) {
                          chartLogger.warn('Minimap', 'RangeSelectionModifier missing/deleted before selectedArea update (with axis)');
                          return;
                        }
                        // Guard: modifier/axis must be attached to a surface before setting selectedArea
                        if (!(rangeSelectionModifierNow as any).parentSurface) {
                          chartLogger.warn('Minimap', 'RangeSelectionModifier has no parentSurface - skipping selectedArea update (with axis)');
                          return;
                        }
                        if (minimapXAxisNow && !(minimapXAxisNow as any).parentSurface) {
                          chartLogger.warn('Minimap', 'Minimap XAxis has no parentSurface - skipping selectedArea update (with axis)');
                          return;
                        }

                        if (setUpdatingFlagNow) setUpdatingFlagNow(true);
                        rangeSelectionModifierNow.selectedArea = newRange;
                        minimapSurfaceNow.invalidateElement();
                        if (setUpdatingFlagNow) setUpdatingFlagNow(false);
                      } catch (e) {
                        chartLogger.error('Minimap', 'Error updating minimap selectedArea after delay', e);
                        try {
                          const refsNow = chartRefs.current;
                          const setUpdatingFlagNow = (refsNow as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
                          if (setUpdatingFlagNow) setUpdatingFlagNow(false);
                        } catch {
                          // ignore
                        }
                      }
                    }, 0);
                  } else {
                    // Axis range is already correct, just update selectedArea with delay
                    if (minimapSelectedAreaUpdateTimeoutRef.current) {
                      clearTimeout(minimapSelectedAreaUpdateTimeoutRef.current);
                    }
                    minimapSelectedAreaUpdateTimeoutRef.current = setTimeout(() => {
                      minimapSelectedAreaUpdateTimeoutRef.current = null;
                      try {
                        const refsNow = chartRefs.current;
                        const minimapSurfaceNow = (refsNow as any).minimapSurface as SciChartSurface | null;
                        const rangeSelectionModifierNow = (refsNow as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
                        const setUpdatingFlagNow = (refsNow as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
                        const minimapXAxisNow = (refsNow as any).minimapXAxis as DateTimeNumericAxis | null;

                        // CRITICAL: Validate surface is still valid before updating
                        if (!minimapSurfaceNow || (minimapSurfaceNow as any).isDeleted) {
                          chartLogger.warn('Minimap', 'Surface deleted before selectedArea update');
                          return;
                        }
                        if (!rangeSelectionModifierNow || (rangeSelectionModifierNow as any).isDeleted) {
                          chartLogger.warn('Minimap', 'RangeSelectionModifier missing/deleted before selectedArea update');
                          return;
                        }
                        if (!(rangeSelectionModifierNow as any).parentSurface) {
                          chartLogger.warn('Minimap', 'RangeSelectionModifier has no parentSurface - skipping selectedArea update');
                          return;
                        }
                        if (minimapXAxisNow && !(minimapXAxisNow as any).parentSurface) {
                          chartLogger.warn('Minimap', 'Minimap XAxis has no parentSurface - skipping selectedArea update');
                          return;
                        }

                        if (setUpdatingFlagNow) setUpdatingFlagNow(true);
                        rangeSelectionModifierNow.selectedArea = newRange;
                        minimapSurfaceNow.invalidateElement();
                        if (setUpdatingFlagNow) setUpdatingFlagNow(false);
                      } catch (e) {
                        chartLogger.error('Minimap', 'Error updating selectedArea', e);
                        try {
                          const refsNow = chartRefs.current;
                          const setUpdatingFlagNow = (refsNow as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
                          if (setUpdatingFlagNow) setUpdatingFlagNow(false);
                        } catch {
                          // ignore
                        }
                      }
                    }, 0);
                  }
                }
              } catch (e) {
                console.warn('[MultiPaneChart] Error ensuring minimap X-axis range during auto-scroll:', e);
                if (minimapSurface) {
                  minimapSurface.resumeUpdates();
                }
              }
            } else {
              // No minimap data yet, just update selectedArea
              if (minimapSelectedAreaUpdateTimeoutRef.current) {
                clearTimeout(minimapSelectedAreaUpdateTimeoutRef.current);
              }
              minimapSelectedAreaUpdateTimeoutRef.current = setTimeout(() => {
                minimapSelectedAreaUpdateTimeoutRef.current = null;
                try {
                  const refsNow = chartRefs.current;
                  const minimapSurfaceNow = (refsNow as any).minimapSurface as SciChartSurface | null;
                  const rangeSelectionModifierNow = (refsNow as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
                  const setUpdatingFlagNow = (refsNow as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
                  const minimapXAxisNow = (refsNow as any).minimapXAxis as DateTimeNumericAxis | null;

                  if (!minimapSurfaceNow || (minimapSurfaceNow as any).isDeleted) {
                    chartLogger.warn('Minimap', 'Surface deleted before selectedArea update (no data)');
                    return;
                  }
                  if (!rangeSelectionModifierNow || (rangeSelectionModifierNow as any).isDeleted) {
                    chartLogger.warn('Minimap', 'RangeSelectionModifier missing/deleted before selectedArea update (no data)');
                    return;
                  }
                  if (!(rangeSelectionModifierNow as any).parentSurface) {
                    chartLogger.warn('Minimap', 'RangeSelectionModifier has no parentSurface - skipping selectedArea update (no data)');
                    return;
                  }
                  if (minimapXAxisNow && !(minimapXAxisNow as any).parentSurface) {
                    chartLogger.warn('Minimap', 'Minimap XAxis has no parentSurface - skipping selectedArea update (no data)');
                    return;
                  }

                  if (setUpdatingFlagNow) setUpdatingFlagNow(true);
                  rangeSelectionModifierNow.selectedArea = newRange;
                  minimapSurfaceNow.invalidateElement();
                  if (setUpdatingFlagNow) setUpdatingFlagNow(false);
                } catch (e) {
                  chartLogger.error('Minimap', 'Error updating selectedArea (no data path)', e);
                  try {
                    const refsNow = chartRefs.current;
                    const setUpdatingFlagNow = (refsNow as any).setUpdatingMinimapProgrammatically as ((val: boolean) => void) | undefined;
                    if (setUpdatingFlagNow) setUpdatingFlagNow(false);
                  } catch {
                    // ignore
                  }
                }
              }, 0);
            }
          } catch (e) {
            console.warn('[MultiPaneChart] Error in minimap auto-scroll update:', e);
            if (setUpdatingFlag) setUpdatingFlag(false);
          }
        }
      } finally {
        setTimeout(() => {
          (refs as any).mainChartSyncInProgress = false;
        }, 100);
      }
      
      // Fallback: Update all X-axes directly if no minimap
      if (false) {
        // Fallback: Update all X-axes directly if no minimap
        for (const [, paneSurface] of refs.paneSurfaces) {
          if (paneSurface.xAxis) {
            try {
              const currentMax = paneSurface.xAxis.visibleRange?.max || 0;
              const diff = Math.abs(currentMax - newRange.max);
              if (!paneSurface.xAxis.visibleRange || diff > X_SCROLL_THRESHOLD) {
                paneSurface.xAxis.visibleRange = newRange;
                paneSurface.surface.invalidateElement();
              }
            } catch (e) {}
          }
        }
        
        // Also sync legacy surfaces
        if (refs.tickSurface?.xAxes.get(0)) {
          refs.tickSurface.xAxes.get(0).visibleRange = newRange;
        }
        if (refs.ohlcSurface?.xAxes.get(0)) {
          refs.ohlcSurface.xAxes.get(0).visibleRange = newRange;
        }
      }
      
      // Update Y-axes periodically (only if user hasn't manually stretched Y-axis)
      if (now - lastYAxisUpdateRef.current >= Y_AXIS_UPDATE_INTERVAL && !yAxisManuallyStretchedRef.current) {
        lastYAxisUpdateRef.current = now;
        
        // Update Y-axis for all panes
        for (const [paneId, paneSurface] of refs.paneSurfaces) {
          try {
            paneSurface.surface.zoomExtentsY();
          } catch (e) {}
        }
        
        if (refs.tickSurface) {
          try { refs.tickSurface.zoomExtentsY(); } catch (e) {}
        }
        if (refs.ohlcSurface) {
          try { refs.ohlcSurface.zoomExtentsY(); } catch (e) {}
        }
      }
    }
    
    lastRenderTimeRef.current = performance.now();
  }, [onDataClockUpdate, config, feedStage, plotLayout, layoutManager]);
  
  // Main processBatchedSamples - handles chunking to prevent UI freezes
  // OPTIMIZED: Uses true async yielding to prevent main thread blocking during history load
  const processBatchedSamples = useCallback(() => {
    // Move samples from buffer to processing queue
    // Use concat instead of spread to avoid "Maximum call stack size exceeded" with large arrays
    if (sampleBufferRef.current.length > 0) {
      processingQueueRef.current = processingQueueRef.current.concat(sampleBufferRef.current);
      sampleBufferRef.current = [];
    }
    pendingUpdateRef.current = null;
    
    // If already processing, the current processing loop will handle new samples
    if (isProcessingRef.current) {
      return;
    }
    
    if (processingQueueRef.current.length === 0) {
      return;
    }
    
    // Start chunked processing
    isProcessingRef.current = true;
    
    // Reset batch counter for this frame
    batchCountRef.current = 0;
    const maxBatches = getMaxBatchesPerFrame();
    const chunkSize = getChunkSize();
    
    // OPTIMIZED: Use async processing with true yielding to prevent UI freezes
    // This ensures the browser can process events (pointermove, etc.) between chunks
    const processChunksAsync = async () => {
      const startTime = performance.now();
      const MAX_MS_PER_FRAME = 16; // Target 60fps - yield if we exceed this
      
      while (processingQueueRef.current.length > 0 && batchCountRef.current < maxBatches) {
        // CRITICAL: If tab became hidden mid-processing, stop immediately.
        // Move remaining data back to sampleBuffer so flushAllSamplesSynchronously
        // will pick it up when the tab becomes visible again.
        if (document.hidden) {
          sampleBufferRef.current = processingQueueRef.current.concat(sampleBufferRef.current);
          processingQueueRef.current = [];
          isProcessingRef.current = false;
          return;
        }
        
        batchCountRef.current++;
        
        // Take next chunk (config-driven size)
        const chunk = processingQueueRef.current.splice(0, chunkSize);
        
        // Process this chunk
        processChunk(chunk);
        
        // CRITICAL: Yield to the browser after each chunk to prevent UI freezes
        // This is what prevents 'pointermove' and 'message' handler violations
        const elapsed = performance.now() - startTime;
        if (elapsed > MAX_MS_PER_FRAME || processingQueueRef.current.length > 0) {
          // True yield using Promise + setTimeout(0)
          // This allows the browser to process pending events
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
      
      isProcessingRef.current = false;
      
      // If more data remains after hitting batch limit, schedule next frame
      // But NOT if tab is hidden - let visibility handler handle it
      if (processingQueueRef.current.length > 0 && !document.hidden) {
        requestAnimationFrame(() => processBatchedSamples());
      }
    };
    
    // Start async processing
    processChunksAsync();
  }, [processChunk]);
  
  /**
   * Synchronously flush ALL buffered samples in one shot.
   * Used by forceChartUpdate at init_complete to instantly render historical data
   * without async yielding. May briefly freeze UI for very large histories.
   */
  const flushAllSamplesSynchronously = useCallback(() => {
    // Consolidate all buffers into processing queue
    if (skippedSamplesBufferRef.current.length > 0) {
      processingQueueRef.current = processingQueueRef.current.concat(skippedSamplesBufferRef.current);
      skippedSamplesBufferRef.current = [];
    }
    if (sampleBufferRef.current.length > 0) {
      processingQueueRef.current = processingQueueRef.current.concat(sampleBufferRef.current);
      sampleBufferRef.current = [];
    }
    
    const totalSamples = processingQueueRef.current.length;
    if (totalSamples === 0) {
      return 0;
    }
    
    console.log(`[MultiPaneChart] ⚡ INSTANT FLUSH: Processing ${totalSamples} samples synchronously`);
    
    // Clear any pending async processing
    pendingUpdateRef.current = null;
    isProcessingRef.current = false;
    
    // Process ALL samples in one shot - no chunking, no yielding
    // This is fast because processChunk uses suspendUpdates/resumeUpdates internally
    const allSamples = processingQueueRef.current;
    processingQueueRef.current = [];
    
    processChunk(allSamples);
    
    console.log(`[MultiPaneChart] ⚡ INSTANT FLUSH complete: ${totalSamples} samples processed`);
    return totalSamples;
  }, [processChunk]);
  
  // CRITICAL: Continuously monitor and remove ZoomExtentsModifier from all surfaces
  // This ensures it's always removed, even if something re-adds it (e.g., when session completes)
  useEffect(() => {
    const removeZoomExtentsModifiers = () => {
      const refs = chartRefs.current;
      
      // Remove from all dynamic panes
      for (const [, paneSurface] of refs.paneSurfaces) {
        try {
          const modifiers = paneSurface.surface.chartModifiers.asArray();
          for (const mod of modifiers) {
            if (mod instanceof ZoomExtentsModifier) {
              paneSurface.surface.chartModifiers.remove(mod);
            }
          }
        } catch (e) {
          // Ignore errors
        }
      }
      
      // Remove from legacy surfaces
      try {
        if (refs.tickSurface) {
          const modifiers = refs.tickSurface.chartModifiers.asArray();
          for (const mod of modifiers) {
            if (mod instanceof ZoomExtentsModifier) {
              refs.tickSurface.chartModifiers.remove(mod);
            }
          }
        }
        if (refs.ohlcSurface) {
          const modifiers = refs.ohlcSurface.chartModifiers.asArray();
          for (const mod of modifiers) {
            if (mod instanceof ZoomExtentsModifier) {
              refs.ohlcSurface.chartModifiers.remove(mod);
            }
          }
        }
      } catch (e) {
        // Ignore errors
      }
    };
    
    // Remove immediately
    removeZoomExtentsModifiers();
    
    // Also set up an interval to continuously check (in case modifiers are re-added)
    const interval = setInterval(removeZoomExtentsModifiers, 1000);
    
    return () => clearInterval(interval);
  }, [feedStage, plotLayout]); // Re-run when feedStage or plotLayout changes
  
  // Toggle CursorModifier on all surfaces based on cursorEnabled
  useEffect(() => {
    const refs = chartRefs.current;
    const cursorColor = theme === 'dark' ? '#50C7E0' : '#3b82f6';
    
    // Update cursor on all dynamic panes
    for (const [, paneSurface] of refs.paneSurfaces) {
      try {
        const modifiers = paneSurface.surface.chartModifiers.asArray();
        const existingCursor = modifiers.find((mod: any) => mod instanceof CursorModifier);
        
        // Set custom label provider on X-axis for cursor formatting
        const xAxis = paneSurface.xAxis;
        if (xAxis) {
          // Store original label provider if not already stored
          if (!(xAxis as any)._originalLabelProvider) {
            (xAxis as any)._originalLabelProvider = xAxis.labelProvider || null;
          }
          // Set custom label provider when cursor is enabled
          if (cursorEnabled) {
            const originalProvider = (xAxis as any)._originalLabelProvider;
            const timezone = config?.chart?.timezone || 'UTC';
            xAxis.labelProvider = createCursorLabelProvider(originalProvider, timezone) as any;
            // Invalidate surface to force label refresh
            paneSurface.surface.invalidateElement();
          } else if ((xAxis as any)._originalLabelProvider !== undefined) {
            // Restore original label provider when cursor is disabled
            const currentProvider = xAxis.labelProvider;
            restoreOriginalLabelProvider(currentProvider);
            xAxis.labelProvider = (xAxis as any)._originalLabelProvider;
            // Invalidate surface to force label refresh
            paneSurface.surface.invalidateElement();
          }
        }
        
        if (cursorEnabled && !existingCursor) {
          // Set label provider BEFORE creating CursorModifier so it uses the updated provider
          if (xAxis) {
            const originalProvider = (xAxis as any)._originalLabelProvider;
            const timezone = config?.chart?.timezone || 'UTC';
            xAxis.labelProvider = createCursorLabelProvider(originalProvider, timezone) as any;
          }
          // Add CursorModifier
          const cursorModifier = new CursorModifier({
            crosshairStroke: cursorColor,
            crosshairStrokeThickness: 1,
            showAxisLabels: true,
            showTooltip: true,
            tooltipContainerBackground: theme === 'dark' ? '#1a1a1a' : '#ffffff',
            hitTestRadius: 20, // Only show series values within 20px of cursor
          });

          paneSurface.surface.chartModifiers.add(cursorModifier);
          paneSurface.surface.invalidateElement();
        } else if (!cursorEnabled && existingCursor) {
          // Remove CursorModifier
          paneSurface.surface.chartModifiers.remove(existingCursor);
          // Restore original label provider after removing cursor
          if (xAxis && (xAxis as any)._originalLabelProvider !== undefined) {
            const currentProvider = xAxis.labelProvider;
            restoreOriginalLabelProvider(currentProvider);
            xAxis.labelProvider = (xAxis as any)._originalLabelProvider;
            paneSurface.surface.invalidateElement();
          }
        }
      } catch (e) {
        console.warn(`[MultiPaneChart] Error toggling cursor on pane:`, e);
      }
    }
    
    // Update cursor on legacy surfaces
    try {
      if (refs.tickSurface) {
        const modifiers = refs.tickSurface.chartModifiers.asArray();
        const existingCursor = modifiers.find((mod: any) => mod instanceof CursorModifier);
        
        // Set custom label provider on X-axis
        const xAxes = refs.tickSurface.xAxes.asArray();
        for (const xAxis of xAxes) {
          if (xAxis instanceof DateTimeNumericAxis) {
            if (!(xAxis as any)._originalLabelProvider) {
              (xAxis as any)._originalLabelProvider = xAxis.labelProvider || null;
            }
            if (cursorEnabled) {
              const originalProvider = (xAxis as any)._originalLabelProvider;
              const timezone = config?.chart?.timezone || 'UTC';
              xAxis.labelProvider = createCursorLabelProvider(originalProvider, timezone) as any;
              // Invalidate surface to force label refresh
              refs.tickSurface.invalidateElement();
            } else if ((xAxis as any)._originalLabelProvider !== undefined) {
              const currentProvider = xAxis.labelProvider;
              restoreOriginalLabelProvider(currentProvider);
              xAxis.labelProvider = (xAxis as any)._originalLabelProvider;
              // Invalidate surface to force label refresh
              refs.tickSurface.invalidateElement();
            }
          }
        }
        
        if (cursorEnabled && !existingCursor) {
          // Set label provider BEFORE creating CursorModifier
          for (const xAxis of xAxes) {
            if (xAxis instanceof DateTimeNumericAxis) {
              const originalProvider = (xAxis as any)._originalLabelProvider;
              const timezone = config?.chart?.timezone || 'UTC';
              xAxis.labelProvider = createCursorLabelProvider(originalProvider, timezone) as any;
            }
          }
          const cursorModifier = new CursorModifier({
            crosshairStroke: cursorColor,
            crosshairStrokeThickness: 1,
            showAxisLabels: true,
            showTooltip: true,
            tooltipContainerBackground: theme === 'dark' ? '#1a1a1a' : '#ffffff',
          });
          refs.tickSurface.chartModifiers.add(cursorModifier);
          refs.tickSurface.invalidateElement();
        } else if (!cursorEnabled && existingCursor) {
          refs.tickSurface.chartModifiers.remove(existingCursor);
          // Restore original label provider after removing cursor
          for (const xAxis of xAxes) {
            if (xAxis instanceof DateTimeNumericAxis && (xAxis as any)._originalLabelProvider !== undefined) {
              const currentProvider = xAxis.labelProvider;
              restoreOriginalLabelProvider(currentProvider);
              xAxis.labelProvider = (xAxis as any)._originalLabelProvider;
            }
          }
          refs.tickSurface.invalidateElement();
        }
      }
      
      if (refs.ohlcSurface) {
        const modifiers = refs.ohlcSurface.chartModifiers.asArray();
        const existingCursor = modifiers.find((mod: any) => mod instanceof CursorModifier);
        
        // Set custom label provider on X-axis
        const xAxes = refs.ohlcSurface.xAxes.asArray();
        for (const xAxis of xAxes) {
          if (xAxis instanceof DateTimeNumericAxis) {
            if (!(xAxis as any)._originalLabelProvider) {
              (xAxis as any)._originalLabelProvider = xAxis.labelProvider || null;
            }
            if (cursorEnabled) {
              const originalProvider = (xAxis as any)._originalLabelProvider;
              const timezone = config?.chart?.timezone || 'UTC';
              xAxis.labelProvider = createCursorLabelProvider(originalProvider, timezone) as any;
              // Invalidate surface to force label refresh
              refs.ohlcSurface.invalidateElement();
            } else if ((xAxis as any)._originalLabelProvider !== undefined) {
              const currentProvider = xAxis.labelProvider;
              restoreOriginalLabelProvider(currentProvider);
              xAxis.labelProvider = (xAxis as any)._originalLabelProvider;
              // Invalidate surface to force label refresh
              refs.ohlcSurface.invalidateElement();
            }
          }
        }
        
        if (cursorEnabled && !existingCursor) {
          // Set label provider BEFORE creating CursorModifier
          for (const xAxis of xAxes) {
            if (xAxis instanceof DateTimeNumericAxis) {
              const originalProvider = (xAxis as any)._originalLabelProvider;
              const timezone = config?.chart?.timezone || 'UTC';
              xAxis.labelProvider = createCursorLabelProvider(originalProvider, timezone) as any;
            }
          }
          const cursorModifier = new CursorModifier({
            crosshairStroke: cursorColor,
            crosshairStrokeThickness: 1,
            showAxisLabels: true,
            showTooltip: true,
            tooltipContainerBackground: theme === 'dark' ? '#1a1a1a' : '#ffffff',
          });
          refs.ohlcSurface.chartModifiers.add(cursorModifier);
          refs.ohlcSurface.invalidateElement();
        } else if (!cursorEnabled && existingCursor) {
          refs.ohlcSurface.chartModifiers.remove(existingCursor);
          // Restore original label provider after removing cursor
          for (const xAxis of xAxes) {
            if (xAxis instanceof DateTimeNumericAxis && (xAxis as any)._originalLabelProvider !== undefined) {
              const currentProvider = xAxis.labelProvider;
              restoreOriginalLabelProvider(currentProvider);
              xAxis.labelProvider = (xAxis as any)._originalLabelProvider;
            }
          }
          refs.ohlcSurface.invalidateElement();
        }
      }
    } catch (e) {
      console.warn(`[MultiPaneChart] Error toggling cursor on legacy surfaces:`, e);
    }
  }, [cursorEnabled, theme]); // Re-run when cursorEnabled or theme changes
  
  // Toggle LegendModifier with visibility checkboxes based on legendsEnabled
  useEffect(() => {
    const refs = chartRefs.current;
    
    // Helper function to ensure series have proper names for legend display
    const ensureSeriesName = (series: any) => {
      if (!series.dataSeries) return;
      
      // Store original name if not already stored
      if (!(series.dataSeries as any)._originalDataSeriesName) {
        (series.dataSeries as any)._originalDataSeriesName = series.dataSeries.dataSeriesName || '';
      }
      
      // Restore or set series name for legend display
      const originalName = (series.dataSeries as any)._originalDataSeriesName;
      if (originalName && originalName !== '') {
        series.dataSeries.dataSeriesName = originalName;
      } else {
        // Fallback: extract from series ID if no original name
        const dataSeries = series.dataSeries;
        const seriesName = dataSeries.dataSeriesName || 'Series';
        series.dataSeries.dataSeriesName = seriesName;
        (series.dataSeries as any)._originalDataSeriesName = seriesName;
      }
    };
    
    // Update LegendModifier on all dynamic panes
    for (const [paneId, paneSurface] of refs.paneSurfaces) {
      try {
        const modifiers = paneSurface.surface.chartModifiers.asArray();
        const existingLegend = modifiers.find((mod: any) => mod instanceof LegendModifier);
        
        if (legendsEnabled && !existingLegend) {
          // Ensure all series have proper names before adding legend
          const renderableSeries = paneSurface.surface.renderableSeries.asArray();
          for (const series of renderableSeries) {
            ensureSeriesName(series);
          }
          
          // Add LegendModifier with visibility checkboxes
          const legendModifier = new LegendModifier({
            showCheckboxes: true,
            showSeriesMarkers: true,
            isCheckedChangedCallback: (series, isChecked) => {
              // Toggle series visibility when checkbox is clicked
              series.isVisible = isChecked;
              console.log(`[Legend] Series "${series.dataSeries?.dataSeriesName}" visibility: ${isChecked}`);
            },
          });
          paneSurface.surface.chartModifiers.add(legendModifier);
          paneSurface.surface.invalidateElement();
          console.log(`[MultiPaneChart] Added LegendModifier with checkboxes to pane: ${paneId}`);
        } else if (!legendsEnabled && existingLegend) {
          // Remove LegendModifier
          paneSurface.surface.chartModifiers.remove(existingLegend);
          paneSurface.surface.invalidateElement();
          console.log(`[MultiPaneChart] Removed LegendModifier from pane: ${paneId}`);
        }
      } catch (e) {
        console.warn(`[MultiPaneChart] Error toggling legend on pane ${paneId}:`, e);
      }
    }
    
    // Update LegendModifier on legacy surfaces
    try {
      if (refs.tickSurface) {
        const modifiers = refs.tickSurface.chartModifiers.asArray();
        const existingLegend = modifiers.find((mod: any) => mod instanceof LegendModifier);
        
        if (legendsEnabled && !existingLegend) {
          const renderableSeries = refs.tickSurface.renderableSeries.asArray();
          for (const series of renderableSeries) {
            ensureSeriesName(series);
          }
          
          const legendModifier = new LegendModifier({
            showCheckboxes: true,
            showSeriesMarkers: true,
            isCheckedChangedCallback: (series, isChecked) => {
              series.isVisible = isChecked;
            },
          });
          refs.tickSurface.chartModifiers.add(legendModifier);
          refs.tickSurface.invalidateElement();
        } else if (!legendsEnabled && existingLegend) {
          refs.tickSurface.chartModifiers.remove(existingLegend);
          refs.tickSurface.invalidateElement();
        }
      }
      
      if (refs.ohlcSurface) {
        const modifiers = refs.ohlcSurface.chartModifiers.asArray();
        const existingLegend = modifiers.find((mod: any) => mod instanceof LegendModifier);
        
        if (legendsEnabled && !existingLegend) {
          const renderableSeries = refs.ohlcSurface.renderableSeries.asArray();
          for (const series of renderableSeries) {
            ensureSeriesName(series);
          }
          
          const legendModifier = new LegendModifier({
            showCheckboxes: true,
            showSeriesMarkers: true,
            isCheckedChangedCallback: (series, isChecked) => {
              series.isVisible = isChecked;
            },
          });
          refs.ohlcSurface.chartModifiers.add(legendModifier);
          refs.ohlcSurface.invalidateElement();
        } else if (!legendsEnabled && existingLegend) {
          refs.ohlcSurface.chartModifiers.remove(existingLegend);
          refs.ohlcSurface.invalidateElement();
        }
      }
    } catch (e) {
      console.warn(`[MultiPaneChart] Error toggling legends on legacy surfaces:`, e);
    }
  }, [legendsEnabled]); // Re-run when legendsEnabled changes
  
  // Track feed stage changes and handle transitions
  // OPTIMIZED: Non-blocking live transition to prevent UI freezes
  useEffect(() => {
    const prevStage = feedStageRef.current;
    feedStageRef.current = feedStage;
    
    // CRITICAL: When session completes, clear all buffers to prevent stale data processing
    // This ensures no data re-plots when coming back to tab or on page refresh
    if (feedStage === 'complete') {
      console.log('[MultiPaneChart] 🛑 Session complete, clearing all sample buffers');
      sampleBufferRef.current = [];
      processingQueueRef.current = [];
      isProcessingRef.current = false;
      if (pendingUpdateRef.current) {
        if (isUsingTimeoutRef.current) {
          clearTimeout(pendingUpdateRef.current as NodeJS.Timeout);
        } else {
          cancelAnimationFrame(pendingUpdateRef.current as number);
        }
        pendingUpdateRef.current = null;
      }
      
      // CRITICAL: Ensure ZoomExtentsModifier is removed when session completes
      // Sometimes modifiers might be re-added during state transitions
      setTimeout(() => {
        const refs = chartRefs.current;
        for (const [, paneSurface] of refs.paneSurfaces) {
          try {
            const modifiers = paneSurface.surface.chartModifiers.asArray();
            for (const mod of modifiers) {
              if (mod instanceof ZoomExtentsModifier) {
                paneSurface.surface.chartModifiers.remove(mod);
              }
            }
          } catch (e) {}
        }
      }, 200);
      
      return;
    }
    
    // Reset history loaded flag when starting new connection
    if (feedStage === 'history' && prevStage === 'idle') {
      historyLoadedRef.current = false;
      initialDataTimeRef.current = null;
      return;
    }
    
    // CRITICAL: During history/delta mode, enable smooth X-axis scrolling to follow latest data
    // This avoids the "shaking" caused by continuous zoomExtents() which recalculates both X and Y axes
    // Instead, we use the same smooth scrolling approach as live mode
    if (feedStage === 'history' || feedStage === 'delta') {
      // Enable session mode during history/delta to show all data as it loads
      sessionModeRef.current = true;
      isLiveRef.current = true; // Enable auto-scroll behavior
      minimapStickyRef.current = true; // Enable sticky minimap
      userInteractedRef.current = false; // Allow auto-scroll
      
      // Set up periodic Y-axis update (not every frame to avoid shaking)
      let yAxisUpdateInterval: ReturnType<typeof setInterval> | null = null;
      let lastYAxisTime = 0;
      const Y_AXIS_UPDATE_INTERVAL = 500; // Update Y-axis every 500ms
      
      yAxisUpdateInterval = setInterval(() => {
        const now = performance.now();
        if (now - lastYAxisTime < Y_AXIS_UPDATE_INTERVAL) return;
        
        if ((feedStageRef.current === 'history' || feedStageRef.current === 'delta') && isReady) {
          const refs = chartRefs.current;
          
          // Suspend all surfaces for batched Y-axis update
          const surfaces: SciChartSurface[] = [];
          for (const [, paneSurface] of refs.paneSurfaces) {
            if (paneSurface.surface) surfaces.push(paneSurface.surface);
          }
          if (refs.tickSurface) surfaces.push(refs.tickSurface);
          if (refs.ohlcSurface) surfaces.push(refs.ohlcSurface);
          
          for (const surface of surfaces) {
            try { surface.suspendUpdates(); } catch (e) { /* ignore */ }
          }
          
          try {
            // Only zoom Y-axis extents (not X), which avoids horizontal shaking
            // Skip if user has manually stretched Y-axis
            if (!yAxisManuallyStretchedRef.current) {
              for (const surface of surfaces) {
                try { surface.zoomExtentsY(); } catch (e) { /* ignore */ }
              }
            }
          } finally {
            for (const surface of surfaces) {
              try { surface.resumeUpdates(); } catch (e) { /* ignore */ }
            }
          }
          
          lastYAxisTime = now;
        }
      }, Y_AXIS_UPDATE_INTERVAL);
      
      return () => {
        if (yAxisUpdateInterval !== null) {
          clearInterval(yAxisUpdateInterval);
          yAxisUpdateInterval = null;
        }
      };
    }
    
    // When transitioning to live, set X-axis range to show latest data
    // CRITICAL: Use requestIdleCallback/setTimeout to avoid blocking UI
    if (feedStage === 'live' && prevStage !== 'live') {
      historyLoadedRef.current = true;
      
      // CRITICAL: Use a retry loop to handle the case where data hasn't been
      // processed yet when the transition fires (async chunked processing)
      const applyLiveRange = (attempt: number) => {
        const refs = chartRefs.current;
        
        // Collect all surfaces to update
        const surfaces: SciChartSurface[] = [];
        if (refs.tickSurface) surfaces.push(refs.tickSurface);
        if (refs.ohlcSurface) surfaces.push(refs.ohlcSurface);
        for (const [, paneSurface] of refs.paneSurfaces) {
          if (paneSurface.surface) surfaces.push(paneSurface.surface);
        }
        
        if (surfaces.length === 0) {
          if (attempt < 5) {
            setTimeout(() => applyLiveRange(attempt + 1), 200);
          }
          return;
        }
        
        // Find data range across all series (quick scan - just get min/max)
        let dataMin = 0;
        let dataMax = 0;
        let hasData = false;
        
        for (const [, entry] of refs.dataSeriesStore) {
          const count = entry.dataSeries.count();
          if (count > 0) {
            try {
              const xRange = entry.dataSeries.getXRange();
              if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
                if (!hasData) {
                  dataMin = xRange.min;
                  dataMax = xRange.max;
                  hasData = true;
                } else {
                  if (xRange.min < dataMin) dataMin = xRange.min;
                  if (xRange.max > dataMax) dataMax = xRange.max;
                }
              }
            } catch (e) { /* ignore */ }
          }
        }
        
        if (!hasData || dataMax <= 0) {
          // No data yet - retry with increasing delay (up to 5 attempts)
          if (attempt < 5) {
            console.log(`[MultiPaneChart] No data found on attempt ${attempt + 1}, retrying in ${200 * (attempt + 1)}ms...`);
            setTimeout(() => applyLiveRange(attempt + 1), 200 * (attempt + 1));
          } else {
            console.warn('[MultiPaneChart] No data found after 5 attempts, giving up on initial range set');
            triggerYAxisScalingOnNextBatchRef.current = true;
          }
          return;
        }
        
        // Mark that panes have data (in case processChunk hasn't set this yet)
        anyPaneHasDataRef.current = true;
        
        // CRITICAL: Suspend ALL surfaces first to prevent multiple redraws
        for (const surface of surfaces) {
          try { surface.suspendUpdates(); } catch (e) { /* ignore */ }
        }
        
        try {
          // Calculate X-axis range
          let liveRange: NumberRange;
          const defaultRange = plotLayout?.xAxisDefaultRange;
          const calculatedRange = defaultRange 
            ? calculateDefaultXAxisRange(defaultRange, dataMax, dataMin, dataMax)
            : null;
          
          if (calculatedRange) {
            liveRange = calculatedRange;
          } else {
            // Default: 2 minute window focused on latest data (in SECONDS)
            const windowSec = 2 * 60;
            const paddingSec = 10;
            liveRange = new NumberRange(dataMax - windowSec, dataMax + paddingSec);
          }
          
          // Set X-axis range for all surfaces
          for (const surface of surfaces) {
            try {
              const xAxis = surface.xAxes.get(0);
              if (xAxis) {
                xAxis.visibleRange = liveRange;
              }
            } catch (e) { /* ignore */ }
          }
          
          // Schedule Y-axis scaling after X-axis is set (deferred to prevent blocking)
          triggerYAxisScalingOnNextBatchRef.current = true;
          lastYAxisUpdateRef.current = 0;
          
        } finally {
          // Resume ALL surfaces - triggers single batched redraw
          for (const surface of surfaces) {
            try { surface.resumeUpdates(); } catch (e) { /* ignore */ }
          }
        }
        
        // Schedule Y-axis zoom extents after a short delay (non-blocking)
        setTimeout(() => {
          const refs2 = chartRefs.current;
          
          // Suspend again for Y-axis updates
          const surfacesToUpdate: SciChartSurface[] = [];
          if (refs2.tickSurface) surfacesToUpdate.push(refs2.tickSurface);
          if (refs2.ohlcSurface) surfacesToUpdate.push(refs2.ohlcSurface);
          for (const [, paneSurface] of refs2.paneSurfaces) {
            if (paneSurface.surface) surfacesToUpdate.push(paneSurface.surface);
          }
          
          for (const surface of surfacesToUpdate) {
            try { surface.suspendUpdates(); } catch (e) { /* ignore */ }
          }
          
          try {
            for (const surface of surfacesToUpdate) {
              try { surface.zoomExtentsY(); } catch (e) { /* ignore */ }
            }
          } finally {
            for (const surface of surfacesToUpdate) {
              try { surface.resumeUpdates(); } catch (e) { /* ignore */ }
            }
          }
        }, 100);
        
        console.log(`[MultiPaneChart] Applied live range (attempt ${attempt + 1}): dataMin=${dataMin}, dataMax=${dataMax}, hasData=${hasData}`);
      };
      
      // Start first attempt after a short delay to allow chunked processing to finish
      setTimeout(() => applyLiveRange(0), 50);
    }
  }, [feedStage, plotLayout, isReady]); // Added isReady to dependencies for history auto-zoom
  
  // Handle tab visibility changes - keep data collection running, restore X-axis range appropriately
  useEffect(() => {
    const handleVisibilityChange = () => {
      // Note: processBatchedSamples is available via closure from the useCallback above
      const refs = chartRefs.current;
      if (!refs.tickSurface || !refs.ohlcSurface) return;
      
      const tickXAxis = refs.tickSurface.xAxes.get(0);
      const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
      
      if (document.hidden) {
        // Tab is being hidden - save current X-axis range state
        if (tickXAxis?.visibleRange && ohlcXAxis?.visibleRange) {
          const tickRange = tickXAxis.visibleRange;
          const ohlcRange = ohlcXAxis.visibleRange;
          
          // Determine if we're showing full range (from earliest data to latest)
          // Check if the range spans from near the earliest data to near the latest data
          let isFullRange = false;
          // Find any series with data to determine if we're showing full range
          for (const [seriesId, entry] of refs.dataSeriesStore) {
            if (entry.dataSeries.count() > 0) {
              try {
                const dataXRange = entry.dataSeries.getXRange();
                if (dataXRange) {
                  const dataWidth = dataXRange.max - dataXRange.min;
                  const visibleWidth = tickRange.max - tickRange.min;
                  // If visible range is close to data range (within 5%), consider it "full range"
                  isFullRange = visibleWidth >= dataWidth * 0.95;
                  break; // Found a series with data, no need to check others
                }
              } catch (e) {
                // Continue with other series
              }
            }
          }
          
          savedXAxisRangeRef.current = {
            tickRange: {
              min: tickRange.min,
              max: tickRange.max,
              width: tickRange.max - tickRange.min,
            },
            ohlcRange: {
              min: ohlcRange.min,
              max: ohlcRange.max,
              width: ohlcRange.max - ohlcRange.min,
            },
            isFullRange,
          };
          
         
        }
      } else {
        // Tab is becoming visible
        // CRITICAL: Skip all processing if session is complete
        // This prevents re-plotting data or modifying chart state after session ends
        if (feedStage === 'complete') {
          console.log('[MultiPaneChart] Tab visible but session complete, skipping data processing');
          return;
        }
        
        // ALWAYS jump to latest data (requirement)
        // The chart should have been processing in background, but process a few more batches
        // to catch up on any remaining samples, then restore the range smoothly
     
        if (tickXAxis && ohlcXAxis) {
          const saved = savedXAxisRangeRef.current;
          // If no saved range, use current range as fallback (for window width calculation)
          const currentTickRange = tickXAxis.visibleRange;
          const currentOhlcRange = ohlcXAxis.visibleRange;
          const defaultWindowMs = saved?.tickRange?.width || (currentTickRange ? (currentTickRange.max - currentTickRange.min) : 5 * 60 * 1000);
          
          // Cancel any pending setTimeout and switch back to requestAnimationFrame
          if (pendingUpdateRef.current && isUsingTimeoutRef.current) {
            clearTimeout(pendingUpdateRef.current as NodeJS.Timeout);
            pendingUpdateRef.current = null;
            isUsingTimeoutRef.current = false;
          }
          
          // Set range FIRST, then process data silently in background
          // This prevents any chart updates from interfering with the range restoration
          const fixRangeThenProcessData = async () => {
            try {
              // Cancel any pending updates to prevent interference
              if (pendingUpdateRef.current !== null) {
                if (isUsingTimeoutRef.current) {
                  clearTimeout(pendingUpdateRef.current as NodeJS.Timeout);
                } else {
                  cancelAnimationFrame(pendingUpdateRef.current as number);
                }
                pendingUpdateRef.current = null;
              }
              
              // Get current data state (if any exists) to determine range
              // But don't process new data yet - set range first
              const remainingBufferSize = sampleBufferRef.current.length;
             
              
              // Get the latest timestamp - CRITICAL: Use lastDataTimeRef as primary source
              // lastDataTimeRef is updated immediately when samples arrive (in appendSamples)
              // Registry might be stale if data hasn't been processed/appended to DataSeries yet
              // This ensures range restoration uses the actual latest data timestamp, not stale registry data
              let globalDataClock = lastDataTimeRef.current;
              
              // Also check registry as secondary source (for series that might not have updated lastDataTimeRef)
              if (registry && registry.length > 0) {
                const registryMax = Math.max(...registry.map(r => r.lastMs || 0));
                // Use whichever is newer - this handles cases where registry is more current
                if (registryMax > globalDataClock) {
                  globalDataClock = registryMax;
                }
              }
              
              // Ensure we have a valid timestamp
              if (globalDataClock === 0 || !isFinite(globalDataClock)) {
                console.warn('[MultiPaneChart] No valid timestamp for range restoration, using current time');
                globalDataClock = Date.now();
              }
              
              // Use global data clock as the source of truth
              const latestTimestamp = globalDataClock;
              
              if (latestTimestamp > 0 && tickXAxis && ohlcXAxis) {
                // Use saved window width if available, otherwise use current range width or default
                const windowMs = saved?.tickRange?.width || defaultWindowMs;
                
                let newTickRange: NumberRange;
                let newOhlcRange: NumberRange;
                
                if (saved?.isFullRange) {
                  // Show entire range: get min from series if available
                  let dataMin = latestTimestamp - windowMs; // Fallback
                  // Find earliest data point from any series in store
                  for (const [seriesId, entry] of refs.dataSeriesStore) {
                    if (entry.dataSeries.count() > 0) {
                      try {
                        const xRange = entry.dataSeries.getXRange();
                        if (xRange && isFinite(xRange.min)) {
                          if (dataMin === null || xRange.min < dataMin) {
                            dataMin = xRange.min;
                          }
                        }
                      } catch (e) {
                        // Continue with other series
                      }
                    }
                  }
                  newTickRange = new NumberRange(dataMin, latestTimestamp);
                  newOhlcRange = new NumberRange(dataMin, latestTimestamp);
                } else {
                  // Show time window: [latestTimestamp - windowMs, latestTimestamp]
                  // This is the key pattern from SciChart documentation
                  newTickRange = new NumberRange(latestTimestamp - windowMs, latestTimestamp);
                  const ohlcWindowMs = saved?.ohlcRange?.width || (currentOhlcRange ? (currentOhlcRange.max - currentOhlcRange.min) : windowMs);
                  newOhlcRange = new NumberRange(latestTimestamp - ohlcWindowMs, latestTimestamp);
                }
                
                // Set the visible range immediately (no delay)
                // Use suspendUpdates/resumeUpdates to ensure the range is applied atomically
                // CRITICAL: Suspend updates BEFORE setting range to prevent any intermediate renders
                refs.tickSurface.suspendUpdates();
                refs.ohlcSurface.suspendUpdates();
                
                try {
                  tickXAxis.visibleRange = newTickRange;
                  ohlcXAxis.visibleRange = newOhlcRange;
                  
                  // Wait a microtask to ensure range is fully set before resuming
                  await new Promise(resolve => setTimeout(resolve, 0));
    } finally {
      refs.tickSurface.resumeUpdates();
      refs.ohlcSurface.resumeUpdates();
                  
                  // Single invalidate after atomic update (no multiple redraws to prevent shaking)
                  // Use requestAnimationFrame to ensure it happens in the next frame
                  requestAnimationFrame(() => {
                    refs.tickSurface.invalidateElement();
                    refs.ohlcSurface.invalidateElement();
                  });
                }
                
                // Verify the range was actually set
                const actualTickMax = tickXAxis.visibleRange?.max;
                const actualOhlcMax = ohlcXAxis.visibleRange?.max;
                
          
                
                // NOW process data in background (after range is set and stable)
                // This ensures no chart updates interfere with the range restoration
                if (remainingBufferSize > 0) {
                  // Wait a bit for the range to fully render before processing data
                  await new Promise(resolve => setTimeout(resolve, 100));
                  
                  // INSTANT FLUSH: Process all buffered data in ONE shot when tab becomes visible
                  // This avoids the slow point-by-point replay caused by browser tab throttling
                  // Use synchronous flush instead of chunked async processing
                  console.log(`[MultiPaneChart] 🔄 Tab visible: Instant flush of ${remainingBufferSize} buffered samples`);
                  const flushedCount = flushAllSamplesSynchronously();
                  console.log(`[MultiPaneChart] ✅ Tab visible flush complete: ${flushedCount} samples rendered instantly`);
                }
                
                // Verify the range after a delay (but don't re-apply aggressively to prevent shaking)
                // Only log if there's a significant difference
                setTimeout(() => {
                  const verifyTickMax = tickXAxis.visibleRange?.max;
                  const verifyOhlcMax = ohlcXAxis.visibleRange?.max;
                  const expectedMax = newTickRange.max;
                  const threshold = 1000; // 1 second threshold - only warn if difference is significant
                  
                  const tickDiff = verifyTickMax ? Math.abs(verifyTickMax - expectedMax) : 0;
                  const ohlcDiff = verifyOhlcMax ? Math.abs(verifyOhlcMax - expectedMax) : 0;
                  
                  // Only re-apply if the difference is significant (prevents minor adjustments from causing shake)
                  if (tickDiff > threshold || ohlcDiff > threshold) {
                    console.warn('[MultiPaneChart] Range was significantly overridden! Re-applying...', {
                      expected: new Date(expectedMax).toISOString(),
                      actualTick: verifyTickMax ? new Date(verifyTickMax).toISOString() : 'not set',
                      actualOhlc: verifyOhlcMax ? new Date(verifyOhlcMax).toISOString() : 'not set',
                      tickDiff: tickDiff,
                      ohlcDiff: ohlcDiff,
                    });
                    
                    refs.tickSurface.suspendUpdates();
                    refs.ohlcSurface.suspendUpdates();
                    try {
                      tickXAxis.visibleRange = newTickRange;
                      ohlcXAxis.visibleRange = newOhlcRange;
                    } finally {
                      refs.tickSurface.resumeUpdates();
                      refs.ohlcSurface.resumeUpdates();
                    }
                    refs.tickSurface.invalidateElement();
                    refs.ohlcSurface.invalidateElement();
                  }
                }, 200); // Longer delay to avoid interfering with initial render
                
                // Clear the saved range so it doesn't interfere
                savedXAxisRangeRef.current = null;
              } else {
                console.warn('[MultiPaneChart] Cannot fix range - no latest timestamp or axes not available');
              }
            } catch (e) {
              console.warn('[MultiPaneChart] Error fixing X-axis range on tab visible:', e);
            }
          };
          
          // Set range FIRST, then process data silently in background
          // This prevents any chart updates from interfering with the range restoration
       
          isRestoringRangeRef.current = true; // Prevent auto-scroll and Y-axis updates from overriding
          fixRangeThenProcessData().then(() => {
            // Clear the flag after a longer delay to allow auto-scroll to resume smoothly
            // This prevents shaking from auto-scroll or Y-axis updates interfering
            // Extended delay ensures range is fully stable and data processing is complete
            setTimeout(() => {
              isRestoringRangeRef.current = false;
             
            }, 3000); // Extended delay to ensure range is fully stable (increased from 1500ms)
          }).catch((e) => {
            console.warn('[MultiPaneChart] Error in fixRangeThenProcessData:', e);
            isRestoringRangeRef.current = false;
          });
        }
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [processBatchedSamples, feedStage]);

  // Append samples with batching - ALWAYS collect data even when paused
  // Data collection continues in background per UI config
  const appendSamples = useCallback((samples: Sample[]) => {
    if (samples.length === 0) return;
    
    // CRITICAL: Do not accept any samples after session is complete
    // This prevents data re-plotting when coming back to tab or server restart
    if (feedStageRef.current === 'complete') {
      console.log('[MultiPaneChart] ⏸️ Session complete, ignoring', samples.length, 'samples');
      return;
    }
    
    // Add samples to buffer - use config buffer size (default 10M)
    // This ensures we can handle large data streams without dropping samples
    const MAX_BUFFER_SIZE = config.dataCollection.backgroundBufferSize;
    if (sampleBufferRef.current.length < MAX_BUFFER_SIZE) {
      sampleBufferRef.current.push(...samples);
    } else {
      // If buffer is too large, keep only the most recent samples
      // This prevents memory issues while preserving recent data
      const keepCount = Math.max(0, MAX_BUFFER_SIZE - samples.length);
      sampleBufferRef.current = [
        ...sampleBufferRef.current.slice(-keepCount),
        ...samples
      ];
    }
    
    // Update time immediately (for clock display) - optimized
    let latestTime = lastDataTimeRef.current;
    for (let i = 0; i < samples.length; i++) {
      const t = samples[i].t_ms;
      if (t > latestTime) latestTime = t;
    }
    if (latestTime > lastDataTimeRef.current) {
      lastDataTimeRef.current = latestTime;
      onDataClockUpdate?.(latestTime);
      
      // Requirement 15.2: Minimap window logic - live mode: right edge should track dataClockMs
      // Update minimap window position in live mode
      const refs = chartRefs.current;
      if (latestTime > 0 && refs.overview && isLiveRef.current && feedStageRef.current === 'live') {
        try {
          const overviewSurface = (refs.overview as any).sciChartSurface;
          if (overviewSurface) {
            const overviewXAxis = overviewSurface.xAxes.get(0);
            if (overviewXAxis) {
              const mainXAxis = refs.tickSurface?.xAxes.get(0) || 
                (plotLayout ? Array.from(refs.paneSurfaces.values())[0]?.xAxis : null);
              
              if (mainXAxis && mainXAxis.visibleRange) {
                const mainRange = mainXAxis.visibleRange;
                if (overviewXAxis.visibleRange) {
                  const currentRange = overviewXAxis.visibleRange;
                  const diff = Math.abs(currentRange.max - mainRange.max) + Math.abs(currentRange.min - mainRange.min);
                  if (diff > 1000) { // 1 second threshold
                    overviewXAxis.visibleRange = new NumberRange(mainRange.min, mainRange.max);
                  }
                }
              }
            }
          }
        } catch (minimapError) {
          // Silently handle minimap update errors
        }
      }
    }
    
    // SIMPLIFIED SCHEDULING - following new-index.html pattern
    // Schedule processing via RAF if not already scheduled
    // CRITICAL: Only process if series are ready, otherwise samples will be skipped and lost
    // For static data feeds (ui-feed.exe), this prevents data loss on full reload
    const refs = chartRefs.current;
    const hasSeries = refs.dataSeriesStore.size > 0;
    const hasPanes = plotLayout ? refs.paneSurfaces.size > 0 : (refs.tickSurface && refs.ohlcSurface);
    
    // CRITICAL: When tab is hidden, do NOT schedule any processing.
    // Just buffer samples. The visibilitychange handler will call
    // flushAllSamplesSynchronously() when the tab becomes visible again,
    // rendering everything in one shot instead of a slow replay.
    if (document.hidden) {
      // Samples are already in sampleBufferRef, nothing else to do
      return;
    }
    
    // Only schedule processing if we have series ready to receive data
    // Otherwise, samples will stay in sampleBufferRef until series are created
    if (pendingUpdateRef.current === null && (hasSeries || isReady)) {
      // Config-driven frame throttling via performance.updateIntervalMs
      const now = performance.now();
      const updateInterval = getUpdateInterval();
      const timeSinceLastRender = now - lastRenderTimeRef.current;
      
      // Only schedule if enough time has passed since last render
      if (timeSinceLastRender >= updateInterval) {
        lastRenderTimeRef.current = now;
        pendingUpdateRef.current = requestAnimationFrame(() => {
          pendingUpdateRef.current = null;
          processBatchedSamples();
        });
      } else {
        // Schedule for later based on remaining time
        const delay = updateInterval - timeSinceLastRender;
        setTimeout(() => {
          if (pendingUpdateRef.current === null) {
            lastRenderTimeRef.current = performance.now();
            pendingUpdateRef.current = requestAnimationFrame(() => {
              pendingUpdateRef.current = null;
              processBatchedSamples();
            });
          }
        }, delay);
      }
    } else if (!hasSeries && !isReady) {
      // Chart not ready yet - samples are buffered and will be processed when series are created
      // Log only occasionally to avoid spam
      if (sampleBufferRef.current.length % 1000 === 0 || sampleBufferRef.current.length === 1) {
        console.log(`[MultiPaneChart] 📦 Buffering samples (${sampleBufferRef.current.length} total) - waiting for series to be created`);
      }
    }
  }, [onDataClockUpdate, processBatchedSamples, config]);

  // Control functions
  const setLiveMode = useCallback((live: boolean) => {
    isLiveRef.current = live;
    // CRITICAL: When enabling live mode, clear user interaction flag to allow auto-scroll
    if (live) {
      userInteractedRef.current = false;
      // Clear any pending interaction timeout
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
        interactionTimeoutRef.current = null;
      }
    }
  }, []);

  const zoomExtents = useCallback(() => {
    // Reset Y-axis manual stretch flag so auto-scaling resumes
    yAxisManuallyStretchedRef.current = false;
    
    // Zoom all dynamic pane surfaces with 2% X-axis padding so edge data isn't clipped
    for (const [paneId, paneSurface] of chartRefs.current.paneSurfaces) {
      try {
        paneSurface.surface.zoomExtents();
        // Add padding to X-axis so leftmost/rightmost points aren't hidden
        const xAxis = paneSurface.surface.xAxes.get(0);
        if (xAxis) {
          const range = xAxis.visibleRange;
          const span = range.max - range.min;
          const pad = span * 0.02;
          xAxis.visibleRange = new NumberRange(range.min - pad, range.max + pad);
        }
        console.log(`[zoomExtents] Zoomed pane: ${paneId}`);
      } catch (e) {
        console.warn(`[zoomExtents] Failed to zoom pane ${paneId}:`, e);
      }
    }
    
    // Also zoom legacy surfaces if they exist
    if (chartRefs.current.tickSurface) {
      chartRefs.current.tickSurface.zoomExtents();
      try {
        const xAxis = chartRefs.current.tickSurface.xAxes.get(0);
        if (xAxis) {
          const range = xAxis.visibleRange;
          const span = range.max - range.min;
          const pad = span * 0.02;
          xAxis.visibleRange = new NumberRange(range.min - pad, range.max + pad);
        }
      } catch (e) {}
    }
    if (chartRefs.current.ohlcSurface) {
      chartRefs.current.ohlcSurface.zoomExtents();
      try {
        const xAxis = chartRefs.current.ohlcSurface.xAxes.get(0);
        if (xAxis) {
          const range = xAxis.visibleRange;
          const span = range.max - range.min;
          const pad = span * 0.02;
          xAxis.visibleRange = new NumberRange(range.min - pad, range.max + pad);
        }
      } catch (e) {}
    }
  }, []);

  const jumpToLive = useCallback(() => {
    console.log(`[jumpToLive] 🚀 Called - Current flags BEFORE:`, {
      isLiveRef: isLiveRef.current,
      userInteractedRef: userInteractedRef.current,
      timeWindowSelectedRef: timeWindowSelectedRef.current,
      selectedWindowMinutes: selectedWindowMinutesRef.current,
      minimapStickyRef: minimapStickyRef.current,
      settingTimeWindowRef: settingTimeWindowRef.current,
      lastDataTime: lastDataTimeRef.current,
    });
    
    // CRITICAL: Clear ALL flags that might block auto-scroll
    isLiveRef.current = true;
    userInteractedRef.current = false;
    // NOTE: Don't clear selectedWindowMinutesRef - we want to use it for X-axis range
    minimapStickyRef.current = true; // Enable sticky mode for live following
    settingTimeWindowRef.current = false; // Clear any stuck flag
    
    // Clear any pending interaction timeout
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current);
      interactionTimeoutRef.current = null;
    }
    
    // Get the X-axis range from minimap selection or time window (similar to double-click handler)
    const lastTime = lastDataTimeRef.current;
    if (lastTime <= 0) {
      console.warn(`[jumpToLive] ⚠️ No lastDataTime available: ${lastTime}`);
      return;
    }
    
    let xRange: NumberRange | null = null;
    const rangeSelectionModifier = (chartRefs.current as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
    
    if (rangeSelectionModifier && rangeSelectionModifier.selectedArea) {
      // Use the minimap selected range directly
      xRange = rangeSelectionModifier.selectedArea;
    } else {
      // Fallback: Calculate from selected time window
      const selectedMinutes = selectedWindowMinutesRef.current;
      const latestTime = lastTime;
      
      if (selectedMinutes !== null && selectedMinutes > 0) {
        // Specific time window: calculate the range
        const windowSec = selectedMinutes * 60;
        const endSec = latestTime / 1000;
        const startSec = endSec - windowSec;
        const paddingSec = windowSec * 0.02;
        xRange = new NumberRange(startSec, endSec + paddingSec);
      } else {
        // No time window selected: use default 5 minutes
        const lastTimeSec = latestTime / 1000;
        const windowSec = 5 * 60; // 5 minutes in seconds
        xRange = new NumberRange(lastTimeSec - windowSec, lastTimeSec + windowSec * 0.05);
      }
    }
    
    // Suspend updates on all surfaces to batch the operations
    const surfacesToResume: any[] = [];
    for (const [, paneSurface] of chartRefs.current.paneSurfaces) {
      try {
        paneSurface.surface.suspendUpdates();
        surfacesToResume.push(paneSurface.surface);
      } catch (e) {}
    }
    if (chartRefs.current.tickSurface) {
      try {
        chartRefs.current.tickSurface.suspendUpdates();
        surfacesToResume.push(chartRefs.current.tickSurface);
      } catch (e) {}
    }
    if (chartRefs.current.ohlcSurface) {
      try {
        chartRefs.current.ohlcSurface.suspendUpdates();
        surfacesToResume.push(chartRefs.current.ohlcSurface);
      } catch (e) {}
    }
    
    try {
      // CRITICAL: Fit Y-axis FIRST for ALL panes simultaneously
      // This ensures Y-axis is properly scaled
      console.log(`[jumpToLive] Fitting Y-axis for all panes`);
      
      for (const [, paneSurface] of chartRefs.current.paneSurfaces) {
        try {
          paneSurface.surface.zoomExtentsY();
          paneSurface.surface.invalidateElement();
        } catch (e) {
          console.warn(`[jumpToLive] Failed to zoom Y extents:`, e);
        }
      }
      // Also apply to legacy surfaces if they exist
      try {
        chartRefs.current.tickSurface?.zoomExtentsY();
        chartRefs.current.tickSurface?.invalidateElement();
        chartRefs.current.ohlcSurface?.zoomExtentsY();
        chartRefs.current.ohlcSurface?.invalidateElement();
      } catch (e) {
        console.warn(`[jumpToLive] Failed to zoom Y extents on legacy surfaces:`, e);
      }
      
      // Fit X-axis to minimap/time window range
      if (xRange) {
        console.log(`[jumpToLive] Setting X-axis range: ${xRange.min} to ${xRange.max}`);
        
        // Update all dynamic panes
        for (const [, paneSurface] of chartRefs.current.paneSurfaces) {
          if (paneSurface?.xAxis) {
            try {
              (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
              paneSurface.xAxis.growBy = new NumberRange(0, 0);
              paneSurface.xAxis.visibleRange = new NumberRange(xRange.min, xRange.max);
            } catch (e) {}
          }
        }
        
        // Update legacy surfaces
        const tickXAxis = chartRefs.current.tickSurface?.xAxes.get(0);
        const ohlcXAxis = chartRefs.current.ohlcSurface?.xAxes.get(0);
        
        if (tickXAxis) {
          try {
            (tickXAxis as any).autoRange = EAutoRange.Never;
            tickXAxis.growBy = new NumberRange(0, 0);
            tickXAxis.visibleRange = new NumberRange(xRange.min, xRange.max);
          } catch (e) {}
        }
        if (ohlcXAxis) {
          try {
            (ohlcXAxis as any).autoRange = EAutoRange.Never;
            ohlcXAxis.growBy = new NumberRange(0, 0);
            ohlcXAxis.visibleRange = new NumberRange(xRange.min, xRange.max);
          } catch (e) {}
        }
        
        // Update minimap range selection (OverviewRangeSelectionModifier) if it exists
        if (rangeSelectionModifier) {
          try {
            // CRITICAL: Validate surface before updating selectedArea
            const minimapSurfaceForUpdate = (chartRefs.current as any).minimapSurface as SciChartSurface | null;
            if (minimapSurfaceForUpdate && !(minimapSurfaceForUpdate as any).isDeleted) {
              rangeSelectionModifier.selectedArea = xRange;
            } else {
              chartLogger.warn('Minimap', 'Surface not valid in setTimeWindow, skipping selectedArea update');
            }
            // CRITICAL: Ensure minimap X-axis always shows full data range for correct overlay
            const minimapXAxis = (chartRefs.current as any).minimapXAxis as DateTimeNumericAxis | null;
            const minimapDataSeries = (chartRefs.current as any).minimapDataSeries as XyDataSeries | null;
            if (minimapXAxis && minimapDataSeries && minimapDataSeries.count() > 0) {
              try {
                const fullDataRange = minimapDataSeries.getXRange();
                if (fullDataRange) {
                  const currentAxisRange = minimapXAxis.visibleRange;
                  if (!currentAxisRange || 
                      Math.abs(currentAxisRange.min - fullDataRange.min) > 0.001 ||
                      Math.abs(currentAxisRange.max - fullDataRange.max) > 0.001) {
                    minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);
                    if (minimapSurfaceForUpdate) {
                      minimapSurfaceForUpdate.invalidateElement();
                    }
                  }
                }
              } catch (e) {
                chartLogger.warn('Minimap', 'Error ensuring minimap X-axis range in jumpToLive', e);
              }
            }
          } catch (e) {
            chartLogger.error('Minimap', 'Error in setTimeWindow minimap update', e);
          }
        }
      }
    } finally {
      // Resume updates immediately to ensure changes are applied
      for (const surface of surfacesToResume) {
        try {
          surface.resumeUpdates();
        } catch (e) {}
      }
      
      // Then invalidate in next frame to ensure redraw
      requestAnimationFrame(() => {
        for (const surface of surfacesToResume) {
          try {
            surface.invalidateElement();
          } catch (e) {}
        }
        console.log(`[jumpToLive] ✅ Completed - New flags AFTER:`, {
          isLiveRef: isLiveRef.current,
          userInteractedRef: userInteractedRef.current,
          minimapStickyRef: minimapStickyRef.current,
          settingTimeWindowRef: settingTimeWindowRef.current,
          selectedWindowMinutes: selectedWindowMinutesRef.current,
        });
      });
    }
  }, []);

  // Set time window - controls minimap selection width (presets for minimap)
  // Sets right edge to latest timestamp, left edge to latest - X minutes
  // This enables "sticky" mode so minimap follows live data
  // REQUIREMENT: Only change X-axis range - do NOT affect series visibility
  const setTimeWindow = useCallback((minutes: number, dataClockMs: number) => {
    console.log(`[setTimeWindow] 🎯 Called with ${minutes} minutes - Current flags BEFORE:`, {
      isLiveRef: isLiveRef.current,
      userInteractedRef: userInteractedRef.current,
      minimapStickyRef: minimapStickyRef.current,
      settingTimeWindowRef: settingTimeWindowRef.current,
      selectedWindowMinutes: selectedWindowMinutesRef.current,
      timeWindowSelectedRef: timeWindowSelectedRef.current,
      lastDataTime: lastDataTimeRef.current,
    });
    
    const refs = chartRefs.current;
    
    if (minutes <= 0) {
      // Zero or negative means show all data (entire session mode)
      // Enable session mode to expand with data in live mode
      sessionModeRef.current = true;
      minimapStickyRef.current = true; // Keep sticky so minimap follows latest data
      timeWindowSelectedRef.current = true; // Mark as selected to trigger auto-scroll
      selectedWindowMinutesRef.current = null; // Clear selected window size
      isLiveRef.current = true; // Enable live mode for auto-scroll
      userInteractedRef.current = false;
      zoomExtents();
      return;
    }
    
    // Disable session mode when a specific time window is selected
    sessionModeRef.current = false;
    
    // Store the selected window size so we can continuously update it in live mode
    // This ensures the window always shows the last X minutes from the latest data
    selectedWindowMinutesRef.current = minutes;
    
    // CRITICAL: Enable sticky mode and live mode when time window is selected from toolbar
    // This ensures the window follows the latest data automatically
    minimapStickyRef.current = true;
    isLiveRef.current = true;
    userInteractedRef.current = false;
    
    // CRITICAL: Reset Y-axis manual stretch flag so Y-axis auto-scales to the new window
    // When user selects a time window, they expect Y-axis to fit the visible data
    yAxisManuallyStretchedRef.current = false;
    lastYAxisUpdateRef.current = 0; // Force immediate Y-axis update on next render
    
    // CRITICAL: Set flag to prevent auto-scroll from overriding during setTimeWindow
    settingTimeWindowRef.current = true;

    // CRITICAL: Use the actual latest data timestamp, not the passed dataClockMs
    // This ensures the time window includes all available data
    // Use lastDataTimeRef as primary source, fallback to dataClockMs, then Date.now()
    const actualLatestTimeMs = lastDataTimeRef.current > 0 
      ? lastDataTimeRef.current 
      : (dataClockMs > 0 ? dataClockMs : Date.now());
    
    // CRITICAL: Convert to SECONDS for SciChart DateTimeNumericAxis
    // SciChart expects Unix timestamps in seconds, not milliseconds
    const windowSec = minutes * 60; // Window size in seconds
    const endSec = actualLatestTimeMs / 1000; // Convert ms to seconds
    const startSec = endSec - windowSec;
    const paddingSec = windowSec * 0.02; // 2% padding on right edge
    const newRange = new NumberRange(startSec, endSec + paddingSec);
    
    console.log(`[setTimeWindow] Setting ${minutes} min window using latest timestamp ${actualLatestTimeMs}: ${new Date(startSec * 1000).toISOString()} - ${new Date(endSec * 1000).toISOString()}`);
    console.log(`[setTimeWindow] Window range in SECONDS: ${startSec} to ${endSec + paddingSec} (window size: ${windowSec}s = ${minutes} minutes)`);
    console.log(`[setTimeWindow] Current time: ${new Date().toISOString()}, Latest data time: ${new Date(actualLatestTimeMs).toISOString()}`);

    // Store the window size for sticky mode auto-scroll (keep in SECONDS for consistency)
    minimapTimeWindowRef.current = windowSec * 1000; // Store as ms for ref but use sec for ranges
    
    // Clear any pending interaction timeout
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current);
      interactionTimeoutRef.current = null;
    }

    // CRITICAL: Update X-axis ranges FIRST, before updating minimap selection
    // This ensures all series are visible in the new range before the minimap updates
    // REQUIREMENT: Only change X-axis range - do NOT affect series visibility
    console.log(`[setTimeWindow] Setting X-axis range on all panes FIRST: ${newRange.min} to ${newRange.max}`);
    
    // CRITICAL: Suspend updates on all surfaces to prevent SciChart from auto-updating the range
    const surfacesToResume: any[] = [];
    for (const [paneId, paneSurface] of refs.paneSurfaces) {
      try {
        paneSurface.surface.suspendUpdates();
        surfacesToResume.push(paneSurface.surface);
      } catch (e) {
        // Ignore if suspend fails
      }
    }
    
    for (const [paneId, paneSurface] of refs.paneSurfaces) {
      if (paneSurface?.xAxis) {
        // CRITICAL: Preserve series visibility - store current visibility state
        const seriesArray = paneSurface.surface.renderableSeries.asArray();
        const visibilityMap = new Map<string, boolean>();
        seriesArray.forEach(rs => {
          try {
            const dataSeries = (rs as any).dataSeries;
            if (dataSeries) {
              visibilityMap.set(dataSeries.dataSeriesName || 'unknown', rs.isVisible);
            }
          } catch (e) {
            // Ignore errors
          }
        });
        
        // Change X-axis range
        // CRITICAL: Disable autoRange to prevent SciChart from overriding our window
        // When a time window is selected, we want to lock the X-axis to that exact range
        if ((paneSurface.xAxis as any).autoRange !== undefined) {
          (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
        }
        // Set visibleRange to the exact window
        paneSurface.xAxis.visibleRange = newRange;
        // CRITICAL: Set growBy to zero to prevent auto-scaling beyond the window
        // growBy might be undefined initially, so we need to create it if it doesn't exist
        try {
          paneSurface.xAxis.growBy = new NumberRange(0, 0);
        } catch (e) {
          // If growBy can't be set, try setting it as a property
          try {
            (paneSurface.xAxis as any).growBy = new NumberRange(0, 0);
          } catch (e2) {
            console.warn(`[setTimeWindow] Could not set growBy on pane ${paneId}:`, e2);
          }
        }
        console.log(`[setTimeWindow] Set X-axis range on pane ${paneId}: ${newRange.min} to ${newRange.max} (${new Date(newRange.min).toISOString()} to ${new Date(newRange.max).toISOString()})`);
        console.log(`[setTimeWindow] X-axis autoRange after setting: ${(paneSurface.xAxis as any).autoRange}, growBy: ${paneSurface.xAxis.growBy?.min}, ${paneSurface.xAxis.growBy?.max}`);
        console.log(`[setTimeWindow] X-axis visibleRange after setting: ${paneSurface.xAxis.visibleRange?.min}, ${paneSurface.xAxis.visibleRange?.max}`);
        
        // CRITICAL: Force a synchronous update to ensure the range is applied
        // Sometimes SciChart needs an explicit update call
        try {
          // Disable autoRange FIRST
          (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
          // Set growBy to zero (always set it, even if undefined)
          try {
            paneSurface.xAxis.growBy = new NumberRange(0, 0);
          } catch (e) {
            (paneSurface.xAxis as any).growBy = new NumberRange(0, 0);
          }
          // Set visibleRange LAST to ensure it's not overridden
          paneSurface.xAxis.visibleRange = newRange;
          // Also invalidate the surface to force a full redraw
          paneSurface.surface.invalidateElement();
        } catch (e) {
          console.warn(`[setTimeWindow] Error forcing X-axis update on pane ${paneId}:`, e);
        }
        
        // CRITICAL: Verify the range was actually set after a short delay
        setTimeout(() => {
          const actualRange = paneSurface.xAxis.visibleRange;
          if (actualRange) {
            const diff = Math.abs(actualRange.min - newRange.min) + Math.abs(actualRange.max - newRange.max);
            if (diff > 1000) { // More than 1 second difference
              console.warn(`[setTimeWindow] ⚠️ X-axis range was changed after setting! Expected: ${newRange.min}-${newRange.max}, Actual: ${actualRange.min}-${actualRange.max}`);
              // Force it again
              (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
              try {
                paneSurface.xAxis.growBy = new NumberRange(0, 0);
              } catch (e) {
                (paneSurface.xAxis as any).growBy = new NumberRange(0, 0);
              }
              paneSurface.xAxis.visibleRange = newRange;
              paneSurface.surface.invalidateElement();
              // NOTE: Do NOT update minimap X-axis here - it should always show full data range
              // The minimap indicator (selectedArea) is already updated separately
            }
          }
        }, 150);
        
        // CRITICAL: Invalidate surface to force re-render with new X-axis range
        // This is especially important when minimap is active, as it ensures series are visible
        try {
          paneSurface.surface.invalidateElement();
        } catch (e) {
          // Ignore invalidation errors
        }
        
        // CRITICAL: Restore series visibility to ensure nothing was accidentally hidden
        // Also ensure ALL series in layout are visible (not just those that were visible before)
        seriesArray.forEach(rs => {
          try {
            const dataSeries = (rs as any).dataSeries;
            if (dataSeries) {
              const seriesName = dataSeries.dataSeriesName || 'unknown';
              const wasVisible = visibilityMap.get(seriesName);
              
              // CRITICAL: If series was visible before, restore it
              if (wasVisible !== undefined && rs.isVisible !== wasVisible) {
                console.warn(`[setTimeWindow] Restoring visibility for ${seriesName} on pane ${paneId}: ${wasVisible}`);
                rs.isVisible = wasVisible;
              }
              
              // CRITICAL: If series is in layout and has data, ensure it's visible
              // This fixes the issue where series become invisible after minimap interaction
              if (plotLayout) {
                const isInLayout = plotLayout.layout.series.some(s => s.series_id === seriesName);
                if (isInLayout && dataSeries.count() > 0 && !rs.isVisible) {
                  console.warn(`[setTimeWindow] ⚠️ Series ${seriesName} is in layout and has data but is INVISIBLE - making it visible`);
                  rs.isVisible = true;
                }
              }
            }
          } catch (e) {
            // Ignore errors
          }
        });
        
        // Force surface update to ensure series are rendered
        paneSurface.surface.invalidateElement();
      }
    }
    
    // Also sync legacy surfaces if they exist
    if (refs.tickSurface?.xAxes.get(0)) {
      refs.tickSurface.xAxes.get(0).visibleRange = newRange;
      refs.tickSurface.invalidateElement();
    }
    if (refs.ohlcSurface?.xAxes.get(0)) {
      refs.ohlcSurface.xAxes.get(0).visibleRange = newRange;
      refs.ohlcSurface.invalidateElement();
    }
    
    // Resume all suspended surfaces AFTER setting the range
    // This ensures all range changes are batched together
    setTimeout(() => {
      for (const surface of surfacesToResume) {
        try {
          surface.resumeUpdates();
        } catch (e) {
          // Ignore if resume fails
        }
      }
      
      // CRITICAL: Refit Y-axis to visible data after X-axis range change
      // Without this, Y-axis stays at its old range and data appears squished at top/bottom
      // Use requestAnimationFrame to ensure X-axis range is fully applied before Y refit
      requestAnimationFrame(() => {
        for (const [paneId, paneSurface] of refs.paneSurfaces) {
          try {
            zoomExtentsYWithHLines(paneSurface.surface, paneId);
            paneSurface.surface.invalidateElement();
            console.log(`[setTimeWindow] Refitted Y-axis for pane ${paneId}`);
          } catch (e) {
            console.warn(`[setTimeWindow] Failed to refit Y-axis for pane ${paneId}:`, e);
          }
        }
        // Also refit legacy surfaces
        try {
          refs.tickSurface?.zoomExtentsY();
          refs.tickSurface?.invalidateElement();
          refs.ohlcSurface?.zoomExtentsY();
          refs.ohlcSurface?.invalidateElement();
        } catch (e) {
          // Ignore
        }
      });
    }, 0); // Use setTimeout to ensure all range changes are applied before resuming
    
    // Update minimap range selection (OverviewRangeSelectionModifier)
    const rangeSelectionModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
    if (rangeSelectionModifier) {
      try {
        // CRITICAL: Validate surface before updating selectedArea
        const minimapSurface = (refs as any).minimapSurface as SciChartSurface | null;
        if (minimapSurface && !(minimapSurface as any).isDeleted) {
          rangeSelectionModifier.selectedArea = newRange;
        } else {
          chartLogger.warn('Minimap', 'Surface not valid in setTimeWindow, skipping selectedArea update');
        }
        
        // CRITICAL: Ensure minimap X-axis always shows full data range for correct overlay
        const minimapXAxis = (refs as any).minimapXAxis as DateTimeNumericAxis | null;
        const minimapDataSeries = (refs as any).minimapDataSeries as XyDataSeries | null;
        if (minimapXAxis && minimapDataSeries && minimapDataSeries.count() > 0) {
          try {
            const fullDataRange = minimapDataSeries.getXRange();
            if (fullDataRange) {
              const currentAxisRange = minimapXAxis.visibleRange;
              if (!currentAxisRange || 
                  Math.abs(currentAxisRange.min - fullDataRange.min) > 0.001 ||
                  Math.abs(currentAxisRange.max - fullDataRange.max) > 0.001) {
                minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);
                if (minimapSurface) {
                  minimapSurface.invalidateElement();
                }
              }
            }
          } catch (e) {
            chartLogger.warn('Minimap', 'Error ensuring minimap X-axis range in setTimeWindow', e);
          }
        }
      } catch (e) {
        chartLogger.error('Minimap', 'Error updating minimap range selection in setTimeWindow', e);
      }
    }
    
    // CRITICAL: setTimeWindow should ONLY change the X-axis range
    // DO NOT modify auto-scroll flags here - let the existing auto-scroll logic handle it
    // The auto-scroll will detect the selected window and update it appropriately
    // Mark that a time window was selected (for auto-scroll to use)
    timeWindowSelectedRef.current = true;
    
    // Notify parent component to update Toolbar display (convert back to ms for UI display)
    if (onTimeWindowChanged) {
      onTimeWindowChanged({
        minutes,
        startTime: startSec * 1000, // Convert back to ms for display
        endTime: (endSec + paddingSec) * 1000, // Convert back to ms for display
      });
    }
    
    // CRITICAL: Keep settingTimeWindowRef true longer to prevent auto-scroll from running immediately
    // This gives the range time to settle before auto-scroll starts updating it
    // Also block mainChartSyncInProgress to prevent minimap feedback loop
    (refs as any).mainChartSyncInProgress = true;
    setTimeout(() => {
      const wasStuck = settingTimeWindowRef.current;
      settingTimeWindowRef.current = false;
      // Clear mainChartSyncInProgress after a delay to allow normal syncing
      setTimeout(() => {
        (refs as any).mainChartSyncInProgress = false;
      }, 100);
      if (wasStuck) {
        console.log(`[setTimeWindow] ✅ Cleared settingTimeWindowRef flag (was stuck: ${wasStuck})`);
      }
    }, 500); // Increased to 500ms to ensure range is fully settled
    
    console.log(`[setTimeWindow] ✅ Completed - Final flags AFTER:`, {
      isLiveRef: isLiveRef.current,
      userInteractedRef: userInteractedRef.current,
      minimapStickyRef: minimapStickyRef.current,
      settingTimeWindowRef: settingTimeWindowRef.current,
      selectedWindowMinutes: selectedWindowMinutesRef.current,
      timeWindowSelectedRef: timeWindowSelectedRef.current,
    });
    
    // X-axes have already been synced above, so we just need to verify series visibility
    // Log series visibility for debugging
    for (const [paneId, paneSurface] of refs.paneSurfaces) {
      const seriesArray = paneSurface.surface.renderableSeries.asArray();
      console.log(`[setTimeWindow] Pane ${paneId}: ${seriesArray.length} series after X-axis change`);
      
      // CRITICAL: Log ALL series on this pane, including their type and visibility
      console.log(`[setTimeWindow] All series on pane ${paneId}:`, seriesArray.map(rs => {
        try {
          const dataSeries = (rs as any).dataSeries;
          return {
            type: rs.constructor.name,
            seriesName: dataSeries?.dataSeriesName || 'unknown',
            visible: rs.isVisible,
            dataCount: dataSeries?.count() || 0,
            stroke: (rs as any).stroke,
            strokeThickness: (rs as any).strokeThickness
          };
        } catch (e) {
          return { type: rs.constructor.name, error: String(e) };
        }
      }));
      
      seriesArray.forEach(rs => {
        try {
          const dataSeries = (rs as any).dataSeries;
          if (dataSeries && dataSeries.count() > 0) {
            const dataRange = dataSeries.getXRange();
            const isVisible = rs.isVisible;
            
            // CRITICAL: Data is stored in milliseconds (t_ms), and newRange is also in milliseconds
            // getXRange() returns the raw data values, which are in MILLISECONDS
            // Both data range and window range are in milliseconds, so compare directly
            let hasDataInRange = false;
            
            if (dataRange) {
              // Data range is ALWAYS in milliseconds (because we append t_ms directly)
              // newRange is also in milliseconds, so compare directly
              hasDataInRange = dataRange.min <= newRange.max && dataRange.max >= newRange.min;
            }
            
            // CRITICAL: Log detailed information about data ranges
            // NOTE: Both data and X-axis range are in MILLISECONDS
            console.log(`[setTimeWindow] Series ${dataSeries.dataSeriesName || 'unknown'}:`, {
              visible: isVisible,
              dataCount: dataSeries.count(),
              dataRangeMs: dataRange ? {
                min: dataRange.min,
                minDate: new Date(dataRange.min).toISOString(),
                max: dataRange.max,
                maxDate: new Date(dataRange.max).toISOString()
              } : 'no range',
              windowRangeMs: {
                min: newRange.min,
                minDate: new Date(newRange.min).toISOString(),
                max: newRange.max,
                maxDate: new Date(newRange.max).toISOString()
              },
              hasDataInWindow: hasDataInRange
            });
            
            if (!isVisible) {
              console.warn(`[setTimeWindow] ⚠️ Series ${dataSeries.dataSeriesName || 'unknown'} is NOT VISIBLE on pane ${paneId}`);
            }
            if (!hasDataInRange && dataRange) {
              console.warn(`[setTimeWindow] ⚠️ Series ${dataSeries.dataSeriesName || 'unknown'} has NO DATA in time window. Data range: [${new Date(dataRange.min).toISOString()}, ${new Date(dataRange.max).toISOString()}], Window: [${new Date(newRange.min).toISOString()}, ${new Date(newRange.max).toISOString()}]`);
            }
          } else {
            console.log(`[setTimeWindow] Series ${(rs as any).dataSeries?.dataSeriesName || 'unknown'}: visible=${rs.isVisible}, no data (count: ${dataSeries?.count() || 0})`);
          }
        } catch (e) {
          console.warn(`[setTimeWindow] Error checking series:`, e);
        }
      });
    }
  }, [zoomExtents]);

  // Reset data state - called when Reset Cursor is clicked
  // IMPORTANT: Must clear the *same* DataSeries instances that RenderableSeries are bound to,
  // otherwise new points will connect to old points (diagonal/straight lines).
  const resetDataState = useCallback(() => {
    const refs = chartRefs.current;

    console.log('[MultiPaneChart] Resetting data state for Reset Cursor');

    // 0) Cancel any scheduled batch processing + drop any buffered samples.
    // If we don't, a queued RAF can append pre-reset samples *after* clears, causing out-of-order X
    // and intermittent “bridge” lines.
    try {
      const pending = pendingUpdateRef.current;
      if (pending !== null) {
        if (typeof pending === 'number') {
          cancelAnimationFrame(pending);
        } else {
          clearTimeout(pending as any);
        }
        pendingUpdateRef.current = null;
      }
    } catch {
      // ignore
      pendingUpdateRef.current = null;
    }
    // Clear ALL sample buffers - this is critical to prevent partial plotting
    sampleBufferRef.current = [];
    skippedSamplesBufferRef.current = [];
    processingQueueRef.current = [];
    isProcessingRef.current = false;
    
    // Clear marker sample history on reset
    refs.markerSampleHistory = [];
    console.log('[MultiPaneChart] All sample buffers cleared (sampleBuffer, skippedSamples, processingQueue, markerHistory)');

    // 1) Clear all DataSeries currently bound to RenderableSeries (dynamic + legacy)
    for (const [, entry] of refs.dataSeriesStore) {
      try {
        entry.dataSeries?.clear();
      } catch {
        // ignore
      }
    }

    // 1b) Clear minimap data series to prevent stray lines in minimap
    try {
      const minimapDataSeries = (refs as any).minimapDataSeries;
      if (minimapDataSeries && typeof minimapDataSeries.clear === 'function') {
        minimapDataSeries.clear();
        console.log('[MultiPaneChart] Minimap data series cleared');
      }
    } catch {
      // ignore
    }

    // 2) Reset pane-level data flags so panes go back to "Waiting for Data..."
    for (const [, paneSurface] of refs.paneSurfaces) {
      paneSurface.hasData = false;
    }

    // 3) Reset seriesHasData tracking (drives per-pane waiting overlays)
    refs.seriesHasData.clear();

    // 4) Clear waiting annotations (they will be recreated by pane logic)
    for (const [paneId, annotation] of refs.waitingAnnotations) {
      try {
        const paneSurface = refs.paneSurfaces.get(paneId);
        if (paneSurface) paneSurface.surface.annotations.remove(annotation);
        annotation.delete();
      } catch {
        // ignore
      }
    }
    refs.waitingAnnotations.clear();

    // 5) Reset global gate so auto-scroll waits for fresh data
    anyPaneHasDataRef.current = false;

    // 6) Re-initialize seriesHasData for current layout (all false)
    const currentLayout = plotLayoutRef.current;
    if (currentLayout) {
      for (const seriesAssignment of currentLayout.layout.series) {
        refs.seriesHasData.set(seriesAssignment.series_id, false);
      }
    }

    console.log('[MultiPaneChart] Data state reset complete');
  }, []);

  /**
   * Force a chart update to render any data that's already in the DataSeries
   * CRITICAL: This is needed when init_complete fires but no new samples arrive
   * (e.g., when market is slow and historical data is already loaded)
   * 
   * At init_complete, this function:
   * 1. First ensures all layout-defined series have RenderableSeries (via ensureSeriesExists)
   * 2. Attaches RenderableSeries to their pooled DataSeries
   * 3. Computes which panes have data
   * 4. Removes "Waiting for Data..." overlay only for panes WITH data
   * 5. Keeps "Waiting for Data..." for panes WITHOUT data
   * 6. Calls surface.invalidateElement() to force a redraw
   */
  const forceChartUpdate = useCallback(() => {
    const refs = chartRefs.current;
    const currentLayout = plotLayoutRef.current;
    console.log('[MultiPaneChart] 🔄 forceChartUpdate (init_complete) called - attaching pooled DataSeries and rendering');
    
    if (!currentLayout) {
      console.log('[MultiPaneChart] No layout loaded - skipping forceChartUpdate');
      return;
    }
    
    // Check if chart surfaces are ready
    if (refs.paneSurfaces.size === 0) {
      console.log('[MultiPaneChart] No pane surfaces ready yet - deferring forceChartUpdate');
      return;
    }
    
    // CRITICAL: Use synchronous flush to instantly render all historical data
    // This replaces the old async loop that caused slow "replay" effect
    const skippedCount = skippedSamplesBufferRef.current.length;
    const bufferedInQueue = sampleBufferRef.current.length + processingQueueRef.current.length;
    
    if (skippedCount > 0 || bufferedInQueue > 0) {
      console.log(`[MultiPaneChart] ⚡ forceChartUpdate: INSTANT FLUSH of ${skippedCount} skipped + ${bufferedInQueue} queued samples`);
      
      // Use synchronous flush - processes ALL samples in one shot
      const flushedCount = flushAllSamplesSynchronously();
      console.log(`[MultiPaneChart] ⚡ Flushed ${flushedCount} samples instantly`);
    }
    
    let totalSeriesChecked = 0;
    let seriesCreated = 0;
    let seriesAttached = 0;
    
    // Step 1: FIRST ensure all series have RenderableSeries attached
    // This must happen before we compute panesWithData
    for (const seriesAssignment of currentLayout.layout.series) {
      const seriesId = seriesAssignment.series_id;
      totalSeriesChecked++;
      
      // Get the pooled DataSeries (contains historical data)
      const pooledEntry = sharedDataSeriesPool.get(seriesId);
      if (!pooledEntry || !pooledEntry.dataSeries) {
        // Series not in pool yet - will be created when data arrives
        console.log(`[MultiPaneChart] Series ${seriesId} not in pool yet`);
        continue;
      }
      
      const pooledDataSeries = pooledEntry.dataSeries;
      
      // Get or create the dataSeriesStore entry
      let entry = refs.dataSeriesStore.get(seriesId);
      
      if (!entry) {
        // No entry yet - create it via ensureSeriesExists
        entry = ensureSeriesExists(seriesId);
        if (entry) {
          seriesCreated++;
          console.log(`[MultiPaneChart] 🆕 Created series entry via ensureSeriesExists: ${seriesId}`);
        } else {
          console.log(`[MultiPaneChart] ⚠️ Could not create series entry for ${seriesId}`);
          continue;
        }
      }
      
      // Entry exists - ensure dataSeries is attached to renderableSeries
      if (entry && entry.renderableSeries) {
        if ((entry.renderableSeries as any).dataSeries !== pooledDataSeries) {
          // Attach pooled DataSeries to the RenderableSeries
          try {
            (entry.renderableSeries as any).dataSeries = pooledDataSeries;
            seriesAttached++;
            console.log(`[MultiPaneChart] 🔗 Attached pooled DataSeries to RenderableSeries: ${seriesId} (${pooledDataSeries.count()} points)`);
          } catch (e) {
            console.warn(`[MultiPaneChart] Failed to attach dataSeries for ${seriesId}:`, e);
          }
        }
        // Update the entry's dataSeries reference
        entry.dataSeries = pooledDataSeries;
      }
    }
    
    console.log(`[MultiPaneChart] Step 1 complete: checked ${totalSeriesChecked} series, created ${seriesCreated}, attached ${seriesAttached}`);
    
    // Step 2: NOW compute which panes have data (after all series are created/attached)
    const panesWithData = new Set<string>();
    let totalSeriesWithData = 0;

    // Also compute a global X range from the data itself.
    // This is critical for cases where the server preloads historical samples and then
    // delays live ticks (e.g., --live-start-delay-sec 60). In that window, we still want
    // the chart to SHOW the historical line immediately.
    let globalXMin = Infinity;
    let globalXMax = -Infinity;
    
    for (const seriesAssignment of currentLayout.layout.series) {
      const seriesId = seriesAssignment.series_id;
      
      // Check the entry in dataSeriesStore (which now should exist if pool had data)
      const entry = refs.dataSeriesStore.get(seriesId);
      if (entry && entry.dataSeries) {
        const pointCount = entry.dataSeries.count();
        
        if (pointCount > 0) {
          totalSeriesWithData++;
          refs.seriesHasData.set(seriesId, true);

          // Track global X extents (DateTimeNumericAxis uses seconds in this project)
          try {
            const xRange = entry.dataSeries.getXRange();
            if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
              globalXMin = Math.min(globalXMin, xRange.min);
              globalXMax = Math.max(globalXMax, xRange.max);
            }
          } catch {
            // Ignore range errors
          }
          
          // Track which pane has data
          const paneId = entry.paneId || layoutManagerRef.current?.getPaneForSeries(seriesId);
          if (paneId) {
            panesWithData.add(paneId);
          }
          
          console.log(`[MultiPaneChart] ✅ Series ${seriesId} in dataSeriesStore with ${pointCount} points (pane: ${paneId})`);
        } else {
          refs.seriesHasData.set(seriesId, false);
        }
      } else {
        // Also check pool directly for any series not in dataSeriesStore
        const pooledEntry = sharedDataSeriesPool.get(seriesId);
        if (pooledEntry && pooledEntry.dataSeries && pooledEntry.dataSeries.count() > 0) {
          totalSeriesWithData++;
          refs.seriesHasData.set(seriesId, true);

          // Track global X extents from pooled series too
          try {
            const xRange = pooledEntry.dataSeries.getXRange();
            if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
              globalXMin = Math.min(globalXMin, xRange.min);
              globalXMax = Math.max(globalXMax, xRange.max);
            }
          } catch {
            // Ignore range errors
          }

          const paneId = layoutManagerRef.current?.getPaneForSeries(seriesId);
          if (paneId) {
            panesWithData.add(paneId);
          }
          console.log(`[MultiPaneChart] ✅ Series ${seriesId} in pool with ${pooledEntry.dataSeries.count()} points (pane: ${paneId}) but NOT in dataSeriesStore`);
        } else {
          refs.seriesHasData.set(seriesId, false);
        }
      }
    }
    
    console.log(`[MultiPaneChart] Step 2 complete: ${totalSeriesWithData} series have data, ${panesWithData.size} panes have data, X range: ${globalXMin} to ${globalXMax}`);
    
    // Step 3: If data exists but the X-axis range is still on a default "now" window,
    // force a linked X visibleRange that actually contains the historical data.
    // IMPORTANT: Only do this if the user hasn't explicitly selected a time window
    // and hasn't interacted (pan/zoom). We don't want to override user intent.
    if (
      panesWithData.size > 0 &&
      isFinite(globalXMin) &&
      isFinite(globalXMax) &&
      globalXMax > globalXMin &&
      !timeWindowSelectedRef.current &&
      !userInteractedRef.current
    ) {
      try {
        // Use configured/stored window size when available; fallback to full-range with small padding.
        const windowSec = minimapTimeWindowRef.current > 0 ? minimapTimeWindowRef.current / 1000 : (globalXMax - globalXMin);
        const paddingSec = Math.max(windowSec * 0.02, 0.5);
        const start = Math.max(globalXMin, globalXMax - windowSec);
        const xRange = new NumberRange(start, globalXMax + paddingSec);

        // Apply to all dynamic panes (linked X-axes requirement)
        for (const [paneId, paneSurface] of refs.paneSurfaces) {
          if (paneSurface?.xAxis) {
            if ((paneSurface.xAxis as any).autoRange !== undefined) {
              (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
            }
            try {
              paneSurface.xAxis.growBy = new NumberRange(0, 0);
            } catch {
              (paneSurface.xAxis as any).growBy = new NumberRange(0, 0);
            }
            paneSurface.xAxis.visibleRange = xRange;
          }
        }

        // Also apply to legacy surfaces (feature parity)
        if (refs.tickSurface?.xAxes.get(0)) {
          const axis = refs.tickSurface.xAxes.get(0);
          if ((axis as any).autoRange !== undefined) {
            (axis as any).autoRange = EAutoRange.Never;
          }
          if (axis.growBy) axis.growBy = new NumberRange(0, 0);
          axis.visibleRange = xRange;
        }
        if (refs.ohlcSurface?.xAxes.get(0)) {
          const axis = refs.ohlcSurface.xAxes.get(0);
          if ((axis as any).autoRange !== undefined) {
            (axis as any).autoRange = EAutoRange.Never;
          }
          if (axis.growBy) axis.growBy = new NumberRange(0, 0);
          axis.visibleRange = xRange;
        }

        console.log(`[MultiPaneChart] 🧭 forceChartUpdate applied linked X-axis range from data: ${xRange.min} to ${xRange.max}`);
      } catch (e) {
        console.warn('[MultiPaneChart] Failed to apply X-axis range from data in forceChartUpdate:', e);
      }
    }

    // Step 4: Update waiting annotations and invalidate surfaces for each pane
    for (const [paneId, paneSurface] of refs.paneSurfaces) {
      const paneHasData = panesWithData.has(paneId);
      
      if (paneHasData) {
        paneSurface.hasData = true;
        
        // Remove waiting annotation if present (this pane has data)
        const waitingAnnotation = refs.waitingAnnotations.get(paneId);
        if (waitingAnnotation) {
          try {
            paneSurface.surface.annotations.remove(waitingAnnotation);
            waitingAnnotation.delete();
            refs.waitingAnnotations.delete(paneId);
            console.log(`[MultiPaneChart] ✅ Removed waiting annotation from pane: ${paneId}`);
          } catch (e) {
            // Ignore deletion errors
          }
        }
        
        // Force Y-axis to auto-range based on visible data (include hlines)
        try {
          zoomExtentsYWithHLines(paneSurface.surface, paneId);
        } catch (e) {
          // Ignore zoom errors
        }
      } else {
        // Pane doesn't have data yet - ensure waiting annotation is visible
        console.log(`[MultiPaneChart] ⏳ Pane ${paneId} still waiting for data`);
      }
      
      // Step 5: Invalidate surface to force redraw
      try {
        paneSurface.surface.invalidateElement();
      } catch (e) {
        // Ignore invalidation errors
      }
    }
    
    // Update anyPaneHasDataRef if any pane has data
    if (panesWithData.size > 0) {
      anyPaneHasDataRef.current = true;
    }
    
    // Step 5: Replay historical strategy markers into scatter series
    // Scatter series are recreated empty on layout reload, but marker data persists in markerSampleHistory
    const markerHistory = refs.markerSampleHistory;
    if (markerHistory.length > 0 && currentLayout && refs.paneSurfaces.size > 0) {
      console.log(`[MultiPaneChart] 🎯 Replaying ${markerHistory.length} historical strategy markers`);
      
      const paneMarkerBatches = new Map<string, Map<MarkerSeriesType, { x: number[], y: number[] }>>();
      
      for (const { series_id, t_ms, t_ns, payload } of markerHistory) {
        const strategyAssignment = currentLayout.getStrategySeriesAssignment(series_id);
        const allAssignments = currentLayout.getAllStrategySeriesAssignments(series_id);
        let targetPanes: string[] = [];
        
        if (allAssignments.length > 0) {
          targetPanes = allAssignments
            .map(sa => sa.pane)
            .filter(paneId => refs.paneSurfaces.has(paneId));
        } else {
          targetPanes = Array.from(currentLayout.strategyMarkerPanes);
        }
        if (targetPanes.length === 0) continue;
        
        const markerXSeconds = toSecondsPrecise(t_ms, t_ns);
        
        // Resolve yvalue PER PANE assignment (each pane may have different yvalue source)
        for (const paneId of targetPanes) {
          const paneAssignment = allAssignments.find(sa => sa.pane === paneId) || strategyAssignment;
          
          let yValue: number | null = null;
          if (paneAssignment?.yvalue) {
            let ySourceDataSeries: XyDataSeries | null = null;
            const ySourceEntry = refs.dataSeriesStore.get(paneAssignment.yvalue);
            if (ySourceEntry?.dataSeries && ySourceEntry.dataSeries.count() > 0) {
              ySourceDataSeries = ySourceEntry.dataSeries as XyDataSeries;
            } else {
              const poolEntry = sharedDataSeriesPool.get(paneAssignment.yvalue);
              if (poolEntry?.dataSeries && poolEntry.dataSeries.count() > 0) {
                ySourceDataSeries = poolEntry.dataSeries as XyDataSeries;
              }
            }
            if (ySourceDataSeries && ySourceDataSeries.count() > 0) {
              const interpolated = interpolateYValue(ySourceDataSeries, markerXSeconds);
              if (interpolated !== null) yValue = interpolated;
            }
          }
          if (yValue === null) {
            yValue = (payload.price as number) || (payload.value as number) || 0;
          }
          if (yValue === 0 && !paneAssignment?.yvalue) continue;
          
          const markerData = parseMarkerFromSample({
            t_ms, v: yValue,
            side: payload.side as string, tag: payload.tag as string,
            type: payload.type as string, direction: payload.direction as string,
            label: payload.label as string,
          }, series_id);
          
          const markerType = getMarkerSeriesType(markerData);
          
          if (!paneMarkerBatches.has(paneId)) {
            paneMarkerBatches.set(paneId, createEmptyMarkerBatches());
          }
          const batch = paneMarkerBatches.get(paneId)!.get(markerType);
          if (batch) {
            batch.x.push(markerData.x);
            batch.y.push(markerData.y);
          }
        }
      }
      
      // Flush batches into scatter series
      // CRITICAL: Clear existing scatter data first to prevent duplicates
      // (markers may have been partially processed during processChunk before forceChartUpdate)
      let totalReplayed = 0;
      for (const [paneId, typeBatches] of paneMarkerBatches) {
        const scatterMap = refs.markerScatterSeries.get(paneId);
        if (!scatterMap) continue;
        
        const paneSurface = refs.paneSurfaces.get(paneId);
        if (!paneSurface) continue;
        
        paneSurface.surface.suspendUpdates();
        try {
          for (const [mType, batch] of typeBatches) {
            const group = scatterMap.get(mType);
            if (group) {
              // Clear existing data before replay to avoid duplicates
              group.dataSeries.clear();
              if (batch.x.length > 0) {
                group.dataSeries.appendRange(batch.x, batch.y);
                totalReplayed += batch.x.length;
              }
            }
          }
        } finally {
          paneSurface.surface.resumeUpdates();
        }
      }
      console.log(`[MultiPaneChart] ✅ Replayed ${totalReplayed} markers into scatter series`);
    }
    
    // Trigger waiting annotation update for panes that still need data
    updateWaitingAnnotations();
    
    console.log(`[MultiPaneChart] ✅ forceChartUpdate complete - ${panesWithData.size} panes have data, ${totalSeriesWithData} series with data`);
  }, [flushAllSamplesSynchronously, updateWaitingAnnotations, ensureSeriesExists]);

  return {
    isReady,
    appendSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
    setTimeWindow,
    chartRefs,
    handleGridReady,
    resetDataState,
    forceChartUpdate,
  };
}
