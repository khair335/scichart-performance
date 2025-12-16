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
  EXyDirection,
  SciChartOverview,
  SciChartDefaults,
  DpiHelper,
  EResamplingMode,
  EExecuteOn,
  // Annotations for strategy markers
  CustomAnnotation,
  BoxAnnotation,
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  ECoordinateMode,
  // Official SciChart minimap range selection modifier
  OverviewRangeSelectionModifier,
} from 'scichart';
import type { Sample } from '@/lib/wsfeed-client';
import { defaultChartConfig } from '@/types/chart';
import { parseSeriesType, isTickChartSeries, isOhlcChartSeries } from '@/lib/series-namespace';
import { PlotLayoutManager } from '@/lib/plot-layout-manager';
import type { ParsedLayout, PlotLayout } from '@/types/plot-layout';
import { DynamicPaneManager, type PaneSurface as DynamicPaneSurface } from '@/lib/dynamic-pane-manager';
import { renderHorizontalLines, renderVerticalLines } from '@/lib/overlay-renderer';
import { groupStrategyMarkers, getConsolidatedSeriesId, type MarkerGroup } from '@/lib/strategy-marker-consolidator';
import { MarkerAnnotationPool, parseMarkerFromSample, type MarkerData } from '@/lib/strategy-marker-renderer';

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
  onTimeWindowChanged?: (window: { minutes: number; startTime: number; endTime: number } | null) => void; // Callback when time window changes (from minimap or setTimeWindow)
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
  // Strategy marker annotation pools per pane
  markerAnnotationPools: Map<string, MarkerAnnotationPool>;
  
  updateFpsCallback?: () => void; // FPS update callback for subscribing to dynamic pane surfaces
}

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
  onTimeWindowChanged,
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
      maxAutoTicks: 6,
      fifoEnabled: true,
      fifoSweepSize: 100000, // Larger FIFO sweep for high-throughput data
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
    }
  }, [plotLayout]);

  // Helper to get preallocation capacity for any series
  const getSeriesCapacity = (): number => {
    return config.data?.buffers.pointsPerSeries ?? 1_000_000;
  };

  // Helper to calculate default X-axis range from plot layout
  const calculateDefaultXAxisRange = (
    defaultRange: PlotLayout['xAxis']['defaultRange'],
    latestTime: number,
    dataMin?: number,
    dataMax?: number
  ): NumberRange | null => {
    if (!defaultRange) return null;

    const now = latestTime > 0 ? latestTime : Date.now();
    let rangeMin: number;
    let rangeMax: number;

    switch (defaultRange.mode) {
      case 'lastMinutes':
        if (defaultRange.value && defaultRange.value > 0) {
          const minutes = defaultRange.value;
          rangeMin = now - (minutes * 60 * 1000);
          rangeMax = now + (10 * 1000); // 10 seconds padding
        } else {
          return null;
        }
        break;

      case 'lastHours':
        if (defaultRange.value && defaultRange.value > 0) {
          const hours = defaultRange.value;
          rangeMin = now - (hours * 60 * 60 * 1000);
          rangeMax = now + (10 * 1000); // 10 seconds padding
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
          const sessionWindow = 8 * 60 * 60 * 1000; // 8 hours
          rangeMin = now - sessionWindow;
          rangeMax = now + (10 * 1000);
        }
        break;

      case 'session':
        // ALWAYS show all data from N=1 to latest point in buffer (dynamic in live mode)
        // This mode continuously expands to show entire data range as new data arrives
        if (dataMin !== undefined && dataMax !== undefined && dataMin < dataMax) {
          const padding = (dataMax - dataMin) * 0.02; // 2% padding for tighter fit
          rangeMin = dataMin - padding;
          rangeMax = dataMax + padding;
        } else {
          // No data yet, use reasonable defaults
          rangeMin = now - (60 * 1000); // 1 minute back
          rangeMax = now + (10 * 1000);
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
   */
  const getRenderableSeriesType = (seriesId: string): 'FastLineRenderableSeries' | 'FastCandlestickRenderableSeries' | 'FastMountainRenderableSeries' => {
    // Check layout for explicit type
    if (plotLayout) {
      const seriesAssignment = plotLayout.layout.series.find(s => s.series_id === seriesId);
      if (seriesAssignment) {
        return seriesAssignment.type;
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
      return refs.dataSeriesStore.get(seriesId)!;
    }
    
    // Only create on-demand if:
    // 1. Panes are ready
    // 2. Series is in layout (don't create series not meant to be plotted)
    // 3. We have valid WASM context
    if (!plotLayout || refs.paneSurfaces.size === 0 || !isReady) {
      return null; // Not ready for on-demand creation
    }
    
    // Check if series is in layout
    if (!isSeriesInLayout(seriesId)) {
      return null; // Series not in layout, don't create
    }
    
    // Can't create if charts aren't ready
    // CRITICAL: For dynamic panes, we don't need legacy surfaces - check for panes instead
    const hasLegacySurfaces = refs.tickSurface && refs.ohlcSurface && refs.tickWasm && refs.ohlcWasm;
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    
    if (!hasLegacySurfaces && !hasDynamicPanes) {
      // Cannot create series: no surfaces available
      return null;
    }
    
    // CRITICAL: Ensure we have a valid WASM context before creating DataSeries
    // This prevents WASM abort errors
    const { paneId, surface, wasm } = getPaneForSeries(seriesId);
    if (!wasm || !surface || !paneId) {
      // Cannot create series: invalid pane/surface/WASM
      return null;
    }
    
    // CRITICAL: Ensure sharedWasm is available for DataSeries creation
    // DataSeries must use sharedWasm to prevent sharing issues
    if (!refs.sharedWasm && !wasm) {
      // Cannot create series: no WASM context
      return null;
    }
    
    const seriesInfo = parseSeriesType(seriesId);
    
    // Only create series that should be plotted on charts
    if (seriesInfo.chartTarget === 'none') {
      return null;
    }
    
    try {
      const capacity = getSeriesCapacity();
      
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
      
      // Create DataSeries with preallocated circular buffer
      let dataSeries: XyDataSeries | OhlcDataSeries;
      let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
      
      if (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') {
          // OHLC bar series - must use OhlcDataSeries
          // PERF: dataIsSortedInX + dataEvenlySpacedInX = major perf gain for time-series
          dataSeries = new OhlcDataSeries(dataSeriesWasm, {
          dataSeriesName: seriesId,
          fifoCapacity: config.performance.fifoEnabled ? capacity : undefined,
          capacity: capacity,
          containsNaN: false,
          dataIsSortedInX: true,
          dataEvenlySpacedInX: true,
        });
        
        // PERF: Use Auto resampling for 10M+ point performance
        renderableSeries = new FastCandlestickRenderableSeries(wasm, {
          dataSeries: dataSeries as OhlcDataSeries,
          strokeUp: '#26a69a',
          brushUp: '#26a69a88',
          strokeDown: '#ef5350',
          brushDown: '#ef535088',
          strokeThickness: 1,
          resamplingMode: EResamplingMode.Auto,
        });
      } else {
        // All other series (tick, indicators, strategy) use XyDataSeries
        // PERF: dataIsSortedInX + dataEvenlySpacedInX = major perf gain for time-series
        dataSeries = new XyDataSeries(dataSeriesWasm, {
          dataSeriesName: seriesId,
          fifoCapacity: config.performance.fifoEnabled ? capacity : undefined,
          capacity: capacity,
          containsNaN: false,
          dataIsSortedInX: true,
          dataEvenlySpacedInX: true,
        });
        
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
        
        // Get point marker setting from layout
        const pointMarker = seriesAssignment?.style?.pointMarker ? undefined : undefined; // TODO: Implement point markers if needed
        
        // Create renderable series based on layout type
        if (renderableSeriesType === 'FastMountainRenderableSeries') {
          renderableSeries = new FastMountainRenderableSeries(wasm, {
            dataSeries: dataSeries as XyDataSeries,
            stroke: stroke,
            fill: fill,
            strokeThickness: strokeThickness,
            pointMarker: pointMarker,
            resamplingMode: EResamplingMode.Auto, // Use Auto for better performance
          });
        } else {
          // Default to FastLineRenderableSeries
          renderableSeries = new FastLineRenderableSeries(wasm, {
            dataSeries: dataSeries as XyDataSeries,
            stroke: stroke,
            strokeThickness: strokeThickness,
            pointMarker: pointMarker,
            resamplingMode: EResamplingMode.Auto, // Use Auto for better performance
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
      
      // Add to appropriate chart surface
      surface.renderableSeries.add(renderableSeries);
      
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
        }
      } else {
        // Legacy surface - invalidate tick or ohlc
        if (seriesInfo.chartTarget === 'tick' && refs.tickSurface) {
          refs.tickSurface.invalidateElement();
        } else if (seriesInfo.chartTarget === 'ohlc' && refs.ohlcSurface) {
          refs.ohlcSurface.invalidateElement();
        }
      }
      
      return entry;
    } catch (e) {
      // Failed to create DataSeries on-demand
      return null;
    }
  };
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
    markerAnnotationPools: new Map<string, MarkerAnnotationPool>(), // Strategy marker annotation pools
  });

  const [isReady, setIsReady] = useState(false);
  const [parentSurfaceReady, setParentSurfaceReady] = useState(false);
  const [overviewNeedsRefresh, setOverviewNeedsRefresh] = useState(0); // Counter to trigger overview refresh
  const [panesReadyCount, setPanesReadyCount] = useState(0); // Track when panes are created (triggers preallocation)
  const overviewNeedsRefreshSetterRef = useRef<((value: number) => void) | null>(null);
  
  // Store the setter in a ref so it can be accessed from processBatchedSamples
  useEffect(() => {
    overviewNeedsRefreshSetterRef.current = setOverviewNeedsRefresh;
  }, []);
  const fpsCounter = useRef({ frameCount: 0, lastTime: performance.now() });
  
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
  const lastDataTimeRef = useRef(0);
  const settingTimeWindowRef = useRef(false); // Flag to prevent auto-scroll from overriding during setTimeWindow
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastYAxisUpdateRef = useRef(0);
  const isCleaningUpOverviewRef = useRef(false);
  const overviewContainerIdRef = useRef<string | null>(null); // Store the container ID used to create overview
  const lastOverviewSourceRef = useRef<{ surfaceId?: string; minimapSourceSeries?: string } | null>(null); // Track last overview source
  const triggerYAxisScalingOnNextBatchRef = useRef(false); // Flag to trigger Y-axis scaling after data is processed
  
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
          maxAutoTicks: 3, // Ultra-reduced label count (3 labels max) for maximum performance
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
          maxAutoTicks: 3, // Ultra-reduced label count (3 labels max) for maximum performance
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
          surface.chartModifiers.add(
            new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection }),
            new RubberBandXyZoomModifier({ isAnimated: false }), // Box zoom without animation for performance
            new ZoomPanModifier({ 
              executeCondition: { button: EExecuteOn.MouseRightButton } 
            }), // Right-click drag to pan
            new ZoomExtentsModifier() // Enable double-click to zoom extents
          );
        };

        addModifiers(tickSurface, tickWasm);
        addModifiers(ohlcSurface, ohlcWasm);

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
          // Strategy marker annotation pools
          markerAnnotationPools: new Map<string, MarkerAnnotationPool>(),
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
          
          // Delete existing overview/minimap if any
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
              // Delete the surface (this will also clean up the data series)
              ((refs as any).minimapSurface as SciChartSurface).delete();
            } catch (e) {
              console.warn('[MultiPaneChart] Error deleting old minimap surface:', e);
            }
            (refs as any).minimapSurface = null;
            (refs as any).minimapDataSeries = null;
            (refs as any).minimapXAxis = null;
            (refs as any).minimapSourceSeriesId = null;
            (refs as any).minimapTargetPaneId = null;
            (refs as any).minimapRangeSelectionModifier = null;
          }
          
          // Get data from dataSeriesStore for the minimap source series
          if (!minimapSourceSeriesId) {
            console.warn('[MultiPaneChart] No minimap source series specified in layout');
            return;
          }
          
          const seriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
          if (!seriesEntry || !seriesEntry.dataSeries) {
            console.log('[MultiPaneChart] Minimap source series not found in dataSeriesStore, will retry when data arrives');
            // Schedule a retry when data arrives - trigger by checking dataSeriesStore size changes
            return;
          }
          
          // Check if source series has data
          const sourceDataSeries = seriesEntry.dataSeries as XyDataSeries;
          let pointCount = 0;
          try {
            pointCount = sourceDataSeries.count();
          } catch (e) {
            console.warn('[MultiPaneChart] Error getting source series count:', e);
            // Continue anyway - minimap will be populated as data arrives
          }
          
          // CRITICAL: Create minimap even if no data yet - it will be populated as data arrives
          // This fixes the issue where minimap is blank initially
          if (pointCount === 0) {
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
          const xAxis = new DateTimeNumericAxis(minimapWasm, {
            axisTitle: '',
            drawLabels: false, // Hide labels - user wants range indicator, not axis numbers
            drawMinorTickLines: false,
            drawMajorTickLines: false, // Hide tick lines - cleaner look
            drawMajorGridLines: false,
            drawMinorGridLines: false,
            autoRange: EAutoRange.Never, // We'll manually set to show full data range
            isVisible: false, // Hide the axis itself - we only want the range indicator
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
          // CRITICAL: Use a reasonable capacity even if pointCount is 0
          const clonedDataSeries = new XyDataSeries(minimapWasm, {
            fifoCapacity: Math.max(pointCount, 100000) + 100000, // Ensure minimum capacity
            isSorted: true,
            containsNaN: false,
          });
          
          // Copy data from source DataSeries to cloned series
          // CRITICAL: Use safe method to avoid memory access errors
          let copiedCount = 0;
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
          
          // Add line series for minimap
          const lineSeries = new FastLineRenderableSeries(minimapWasm, {
            dataSeries: clonedDataSeries,
            stroke: '#4CAF50',
            strokeThickness: 1,
          });
          minimapSurface.renderableSeries.add(lineSeries);
          
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
          const rangeSelectionModifier = new OverviewRangeSelectionModifier();
          
          // Initialize the selected area from main chart visible range
          if (initialSelectedArea) {
            rangeSelectionModifier.selectedArea = initialSelectedArea;
          } else {
            // Default to showing last 2 minutes if no initial range
            const now = Date.now();
            rangeSelectionModifier.selectedArea = new NumberRange(now - 2 * 60 * 1000, now);
          }
          
          // Helper function to apply X range to all linked charts
          const applyLinkedXRange = (range: NumberRange) => {
            // Any minimap interaction is a "paused window" selection.
            isLiveRef.current = false;
            minimapStickyRef.current = false;
            userInteractedRef.current = true;

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
          
          // When the range selection is moved/resized, update the linked main charts
          rangeSelectionModifier.onSelectedAreaChanged = (selectedRange: NumberRange) => {
            if ((refs as any).minimapSyncInProgress || settingTimeWindowRef.current) {
              return; // Prevent feedback loop
            }
            applyLinkedXRange(selectedRange);
          };
          
          // Add the modifier to the minimap surface
          minimapSurface.chartModifiers.add(rangeSelectionModifier);
          
          // Store reference for external updates (setTimeWindow, auto-scroll, etc.)
          (refs as any).minimapRangeSelectionModifier = rangeSelectionModifier;
          
          // Subscribe to main chart X-axis changes to update the range selection
          // This keeps the minimap range indicator in sync when main charts are panned/zoomed directly
          const subscribeToMainAxisChanges = (mainAxis: DateTimeNumericAxis) => {
            return mainAxis.visibleRangeChanged.subscribe((args: any) => {
              if ((refs as any).minimapSyncInProgress || settingTimeWindowRef.current) {
                return; // Prevent feedback loop
              }
              
              try {
                const currentRange = mainAxis.visibleRange;
                if (currentRange) {
                  // Clip the range to minimap's visible range
                  const minimapXRange = xAxis.visibleRange;
                  if (minimapXRange) {
                    const clippedRange = currentRange.clip(minimapXRange);
                    const currentSelected = rangeSelectionModifier.selectedArea;
                    
                    // Only update if significantly different to avoid jitter
                    if (!currentSelected || 
                        Math.abs(currentSelected.min - clippedRange.min) > 100 ||
                        Math.abs(currentSelected.max - clippedRange.max) > 100) {
                      (refs as any).minimapSyncInProgress = true;
                      rangeSelectionModifier.selectedArea = clippedRange;
                      setTimeout(() => {
                        (refs as any).minimapSyncInProgress = false;
                      }, 50);
                    }
                  }
                }
              } catch (e) {
                // Silently ignore sync errors
              }
            });
          };
          
          // Subscribe to the target pane's X-axis (the pane containing the minimap source series)
          let axisSubscription: any = null;
          if (targetPaneSurface?.xAxis) {
            axisSubscription = subscribeToMainAxisChanges(targetPaneSurface.xAxis);
          }
          (refs as any).minimapAxisSubscription = axisSubscription;
          
          // Initialize minimap X-axis to show FULL data range
          let fullDataRange: NumberRange | undefined;
          if (clonedDataSeries && clonedDataSeries.count() > 0) {
            const dataRange = clonedDataSeries.getXRange();
            if (dataRange) {
              fullDataRange = new NumberRange(dataRange.min, dataRange.max);
            }
          }
          
          // Set minimap to show full range
          if (fullDataRange) {
            xAxis.visibleRange = fullDataRange;
            console.log(`[Minimap] Initialized to show full data range: ${new Date(fullDataRange.min).toISOString()} to ${new Date(fullDataRange.max).toISOString()}`);
          } else if (initialSelectedArea) {
            xAxis.visibleRange = initialSelectedArea;
          } else if (targetPaneSurface?.xAxis?.visibleRange) {
            xAxis.visibleRange = targetPaneSurface.xAxis.visibleRange;
          }
          
          // Store references for updates and cleanup
          (refs as any).minimapSurface = minimapSurface;
          (refs as any).minimapDataSeries = clonedDataSeries;
          (refs as any).minimapSourceSeriesId = minimapSourceSeriesId;
          (refs as any).minimapTargetPaneId = targetPaneId;
          (refs as any).minimapXAxis = xAxis;
          
          // CRITICAL: If minimap was created with no data, trigger a re-sync
          if (copiedCount === 0 && sourceDataSeries.count() > 0) {
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
          }
        }
      } catch (e) {
        console.warn('[MultiPaneChart] Failed to create/show overview:', e);
      }
    };

    handleOverview();

    // NO CLEANUP HERE - we only delete on component unmount (see main useEffect cleanup)
  }, [overviewContainerId, isReady, plotLayout, overviewNeedsRefresh]);

  // Separate cleanup effect that only runs on component unmount
  useEffect(() => {
    return () => {
      const refs = chartRefs.current;
      
      // Cleanup standalone minimap surface (for multi_surface layouts)
      if ((refs as any).minimapSurface) {
        try {
          ((refs as any).minimapSurface as SciChartSurface).delete();
        } catch (e) {
          // Ignore cleanup errors
        }
        (refs as any).minimapSurface = null;
        (refs as any).minimapDataSeries = null;
        (refs as any).minimapSourceSeriesId = null;
        (refs as any).minimapTargetPaneId = null;
        (refs as any).minimapXAxis = null;
        (refs as any).minimapRangeSelectionModifier = null;
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
    
    // Log when effect runs to debug state updates
    console.log(`[MultiPaneChart] 🔄 Preallocation effect triggered: registry=${registry.length}, panes=${refs.paneSurfaces.size}, isReady=${isReady}, panesReadyCount=${panesReadyCount}, hasPlotLayout=${!!plotLayout}`);
    
    // Check if we have either legacy surfaces OR dynamic panes
    const hasLegacySurfaces = refs.tickSurface && refs.ohlcSurface && refs.tickWasm && refs.ohlcWasm;
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    
    if (!hasLegacySurfaces && !hasDynamicPanes) {
      console.log('[MultiPaneChart] ⏸️ Preallocation skipped: no surfaces ready', {
        hasLegacySurfaces,
        hasDynamicPanes: plotLayout && refs.paneSurfaces.size > 0,
        paneSurfacesCount: refs.paneSurfaces.size
      });
      return;
    }
    if (!registry || registry.length === 0) {
      console.log('[MultiPaneChart] ⏸️ Preallocation skipped: registry empty', {
        registry: registry?.length || 0,
        panesReady: refs.paneSurfaces.size > 0,
        isReady,
        hasPlotLayout: !!plotLayout
      });
      
      // CRITICAL: The effect will automatically re-run when registry changes (it's in dependency array)
      // But log this so we can track when registry arrives
      if (hasDynamicPanes && isReady && plotLayout) {
        console.log('[MultiPaneChart] ⏳ Waiting for registry to populate (effect will re-run when registry changes)');
      }
      
      return;
    }
    
    console.log(`[MultiPaneChart] 🔄 Preallocation check: registry=${registry.length}, panes=${refs.paneSurfaces.size}, isReady=${isReady}`);

    // CRITICAL: For dynamic panes, ensure panes are created AND match the current layout
    if (plotLayout) {
      const layoutPanes = new Set(plotLayout.layout.panes.map(p => p.id));
      const existingPanes = new Set(refs.paneSurfaces.keys());
      
      // Check if we have the right number of panes
      if (refs.paneSurfaces.size === 0) {
        console.warn('[MultiPaneChart] ⚠️ Preallocation skipped: dynamic panes not created yet', {
          registryLength: registry.length,
          plotLayoutPanes: layoutPanes.size,
          paneSurfacesCount: refs.paneSurfaces.size,
          isReady
        });
        return;
      }
      
      // CRITICAL: Check if existing panes match the current layout
      // This prevents trying to create series for new layout using old panes
      const panesMatch = layoutPanes.size === existingPanes.size && 
        Array.from(layoutPanes).every(paneId => existingPanes.has(paneId));
      
      if (!panesMatch) {
        console.warn('[MultiPaneChart] ⚠️ Preallocation skipped: panes don\'t match current layout', {
          registryLength: registry.length,
          layoutPanes: Array.from(layoutPanes),
          existingPanes: Array.from(existingPanes),
          paneSurfacesCount: refs.paneSurfaces.size,
          isReady
        });
        return;
      }
    }
    if (!isReady) {
      console.log('[MultiPaneChart] ⏸️ Preallocation skipped: chart not ready');
      return; // Wait for charts to be initialized
    }
    
    // Log registry vs layout comparison for debugging
    const layoutSeriesIds = plotLayout?.layout?.series?.map(s => s.series_id) || [];
    const registrySeriesIdsArray = registry.map(r => r.id);
    const inLayout = registrySeriesIdsArray.filter(id => layoutSeriesIds.includes(id));
    const notInLayout = registrySeriesIdsArray.filter(id => !layoutSeriesIds.includes(id));
    
    console.log(`[MultiPaneChart] 🔄 Starting preallocation: ${registry.length} in registry, ${layoutSeriesIds.length} in layout`);
    if (inLayout.length > 0) {
      console.log(`[MultiPaneChart] ✅ Series in layout (will be created): ${inLayout.join(', ')}`);
    }
    if (notInLayout.length > 0) {
      console.log(`[MultiPaneChart] ⏭️ Series NOT in layout (will be skipped): ${notInLayout.slice(0, 10).join(', ')}${notInLayout.length > 10 ? ` ... (+${notInLayout.length - 10} more)` : ''}`);
    }
    
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
    
    console.log(`[MultiPaneChart] 📊 Preallocation status: ${preallocatedSeriesIds.size} preallocated, ${missingSeries.length} missing from ${chartableSeriesInLayout.length} chartable in layout (${registry.length} total in registry)`);
    
    if (missingSeries.length === 0 && chartableSeriesInLayout.length > 0) {
      // All chartable series IN THE CURRENT LAYOUT are already preallocated, skip this run
      console.log(`[MultiPaneChart] ✅ All ${chartableSeriesInLayout.length} chartable series in layout already preallocated (dataSeriesStore has ${refs.dataSeriesStore.size} entries, ${preallocatedSeriesIds.size} fully created)`);
      return;
    } else if (missingSeries.length > 0) {
      console.log(`[MultiPaneChart] 📋 Preallocation needed: ${missingSeries.length} missing, ${preallocatedSeriesIds.size} already created. Missing: ${missingSeries.slice(0, 5).map(r => r.id).join(', ')}${missingSeries.length > 5 ? ` ... (+${missingSeries.length - 5} more)` : ''}`);
    }
    
    // CRITICAL: Only count missing series that are in the CURRENT layout
    // This ensures we create series for the new layout when layout changes
    const missingCount = missingSeries.length;
    
    console.log(`[MultiPaneChart] 📊 Preallocation status: ${preallocatedSeriesIds.size} preallocated, ${missingCount} missing from ${chartableSeriesInLayout.length} chartable in layout (${registry.length} total in registry)`);
    
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
        
        // Check if we should reuse existing DataSeries (for orphaned series)
        const existingEntry = refs.dataSeriesStore.get(seriesId);
        const shouldReuseDataSeries = existingEntry && existingEntry.dataSeries && (!existingEntry.renderableSeries || !existingEntry.paneId);
        
        // Create DataSeries with preallocated circular buffer (same logic as ensureSeriesExists)
        let dataSeries: XyDataSeries | OhlcDataSeries;
        let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
        
        // Reuse existing DataSeries if available (for orphaned series)
        if (shouldReuseDataSeries && existingEntry.dataSeries) {
          dataSeries = existingEntry.dataSeries;
       
        } else {
          // Create new DataSeries
          if (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') {
            // OHLC bar series - must use OhlcDataSeries
            dataSeries = new OhlcDataSeries(dataSeriesWasm, {
            dataSeriesName: seriesId,
            fifoCapacity: capacity,
            capacity: capacity,
            containsNaN: false,
            dataIsSortedInX: true,
            dataEvenlySpacedInX: false,
          });
          } else {
            // All other series (tick, indicators, strategy) use XyDataSeries
            dataSeries = new XyDataSeries(dataSeriesWasm, {
            dataSeriesName: seriesId,
            fifoCapacity: capacity,
            capacity: capacity,
            containsNaN: false,
            dataIsSortedInX: true,
            dataEvenlySpacedInX: false,
          });
          }
          
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
          
          // Get point marker setting from layout
          const pointMarker = seriesAssignment?.style?.pointMarker ? undefined : undefined; // TODO: Implement point markers if needed
          
          // Create renderable series based on layout type
          if (renderableSeriesType === 'FastMountainRenderableSeries') {
            renderableSeries = new FastMountainRenderableSeries(wasm, {
              dataSeries: dataSeries as XyDataSeries,
              stroke: stroke,
              fill: fill,
              strokeThickness: strokeThickness,
              pointMarker: pointMarker,
              resamplingMode: EResamplingMode.Auto,
            });
          } else {
            // Default to FastLineRenderableSeries
            renderableSeries = new FastLineRenderableSeries(wasm, {
              dataSeries: dataSeries as XyDataSeries,
              stroke: stroke,
              strokeThickness: strokeThickness,
              pointMarker: pointMarker,
              resamplingMode: EResamplingMode.Auto,
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
                resamplingMode: EResamplingMode.Auto,
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
      const hasPreservedData = preservedDataSeriesRef.current.size > 0;
      const shouldRefresh = dataRestoredDuringPreallocation || hasPreservedData;
      
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
                
                // Set X-axis range and auto-scale Y-axis
                paneSurface.surface.suspendUpdates();
                try {
                  paneSurface.xAxis.visibleRange = newXRange;
                  // Auto-scale Y-axis based on data
                  paneSurface.surface.zoomExtentsY();
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
      setParentSurfaceReady(false);

      // Clean up the pane manager (this will properly cleanup all panes and parent surface)
      if (paneManagerRef.current && !cleanupInProgressRef.current) {
        // Store reference to old manager and set to null immediately
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
        oldManager.cleanup().then(() => {
          console.log('[MultiPaneChart] No layout cleanup complete');

          // NOW clear our local references after cleanup is done
          refs.paneSurfaces.clear();

          // CRITICAL: Clear dataSeriesStore entries that have renderableSeries
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              refs.dataSeriesStore.delete(seriesId);
            }
          }

          // Clear preallocated series tracking
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

          // Even on error, clear references to prevent memory leaks
          refs.paneSurfaces.clear();
          
          // Preserve DataSeries data before clearing (same as success path)
          // We preserve for ALL feeds, but only restore for non-live feeds
          preservedDataSeriesRef.current.clear();
          
          // Always preserve data if it exists, regardless of feedStage
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries && entry.dataSeries) {
              try {
                // CRITICAL: Check if DataSeries is still valid before accessing
                if (!entry.dataSeries || (entry.dataSeries as any).isDeleted) {
                  continue; // Skip deleted DataSeries
                }
                
                const dataCount = entry.dataSeries.count();
                if (dataCount > 0 && dataCount < 1000000) { // Sanity check: reasonable data size
                  // Get WASM from renderableSeries surface or from sharedWasm
                  const wasm = (entry.renderableSeries as any).sciChartSurface?.webAssemblyContext2D || refs.sharedWasm;
                  if (wasm) {
                    preservedDataSeriesRef.current.set(seriesId, {
                      dataSeries: entry.dataSeries,
                      wasm: wasm
                    });
                    const isLiveFeed = feedStage === 'live' || feedStage === 'delta';
                    console.log(`[MultiPaneChart] 💾 Preserving data for ${seriesId}: ${dataCount} points (error path, feedStage: ${feedStage}, will${isLiveFeed ? ' NOT' : ''} restore)`);
                  }
                }
              } catch (preserveError) {
                // Silently skip if DataSeries is invalid or deleted
                // This is expected during cleanup
              }
            }
          }
          
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              try {
                (entry.renderableSeries as any).dataSeries = null;
              } catch (e) {
                // Ignore
              }
              refs.dataSeriesStore.delete(seriesId);
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
    const layoutId = JSON.stringify(plotLayout.layout.panes.map(p => ({ id: p.id, row: p.row, col: p.col })));

    // If layout changed, reset everything
    if (currentLayoutIdRef.current && currentLayoutIdRef.current !== layoutId) {
      console.log('[MultiPaneChart] Layout changed, resetting state');

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
        oldManager.cleanup().then(() => {
          console.log('[MultiPaneChart] Layout change cleanup complete');

          // NOW clear our local references after cleanup is done
          refs.paneSurfaces.clear();

          // CRITICAL: Preserve DataSeries data before clearing entries
          // We preserve for ALL feeds, but only restore for non-live feeds
          // This ensures static feeds (like ui-feed.exe) work even if feedStage is 'live'
          // For live feeds, we preserve but won't restore (new data will arrive)
          preservedDataSeriesRef.current.clear();
          
          // Always preserve data if it exists, regardless of feedStage
          // The restoration logic will decide whether to actually restore based on feedStage
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries && entry.dataSeries) {
              // Preserve the DataSeries and WASM context so we can copy data to new series
              // This is critical for static data feeds where data won't be resent
              try {
                // CRITICAL: Check if DataSeries is still valid before accessing
                // This prevents WASM memory errors from accessing deleted DataSeries
                if (!entry.dataSeries || (entry.dataSeries as any).isDeleted) {
                  continue; // Skip deleted DataSeries
                }
                
                const dataCount = entry.dataSeries.count();
                if (dataCount > 0 && dataCount < 1000000) { // Sanity check: reasonable data size
                  // Get WASM from renderableSeries surface or from sharedWasm
                  const wasm = (entry.renderableSeries as any).sciChartSurface?.webAssemblyContext2D || refs.sharedWasm;
                  if (wasm) {
                    // Store reference to DataSeries and WASM for later restoration
                    preservedDataSeriesRef.current.set(seriesId, {
                      dataSeries: entry.dataSeries,
                      wasm: wasm
                    });
                    const isLiveFeed = feedStage === 'live' || feedStage === 'delta';
                    console.log(`[MultiPaneChart] 💾 Preserving data for ${seriesId}: ${dataCount} points (feedStage: ${feedStage}, will${isLiveFeed ? ' NOT' : ''} restore)`);
                  }
                }
              } catch (e) {
                // Silently skip if DataSeries is invalid or deleted
                // This is expected during cleanup
              }
            }
          }

          // CRITICAL: Clear dataSeriesStore entries that have renderableSeries
          // The renderableSeries will be destroyed when panes are destroyed
          // but we need to clear the store so series can be recreated
          // DataSeries data is preserved above and will be restored when new series are created
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              // Detach dataSeries from renderableSeries before deleting entry
              // The DataSeries itself is preserved in preservedDataSeriesRef
              try {
                (entry.renderableSeries as any).dataSeries = null;
              } catch (e) {
                // Ignore
              }
              refs.dataSeriesStore.delete(seriesId);
            }
          }

          // Clear preallocated series tracking
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

          // Even on error, clear references to prevent memory leaks
          refs.paneSurfaces.clear();
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              refs.dataSeriesStore.delete(seriesId);
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
            
            // FPS tracking is now handled by requestAnimationFrame at the top level
            // No need to subscribe to surface rendered events
            
            // Add double-click handler for fit-all + pause
            // Requirement 22.1: Double-click = fit-all + pause
            const surfaceElement = paneSurface.surface.domCanvas2D;
            if (surfaceElement) {
              surfaceElement.addEventListener('dblclick', () => {
                // Zoom extents is already handled by ZoomExtentsModifier
                // Pause auto-scroll, but allow live toggle to override
                isLiveRef.current = false;
                userInteractedRef.current = true;
                // Clear any pending timeout
                if (interactionTimeoutRef.current) {
                  clearTimeout(interactionTimeoutRef.current);
                  interactionTimeoutRef.current = null;
                }
              });
              
              // Add user interaction detection for pan/zoom; we no longer sync main chart
              // back into minimap selection to keep minimap window edges fixed where
              // the user placed them. Minimap is controlled only by its own drag and
              // Last X Time Window presets.
              const syncMinimapSelection = () => {
                // CRITICAL: Only pause auto-scroll if user is actually interacting
                // Don't block if live mode is explicitly enabled via toggle
                setTimeout(() => {
                  // Only mark as interacted if we're not in explicit live mode
                  // This allows the live toggle to work even after user interactions
                  minimapStickyRef.current = false;
                  // Don't automatically set isLiveRef = false here - let the toggle control it
                  // Only set userInteractedRef if we're not in live mode
                  if (!isLiveRef.current) {
                    userInteractedRef.current = true;
                  }
                }, 50);
              };
              
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
            if (paneConfig.overlays) {
              // Render horizontal lines
              if (paneConfig.overlays.hline && paneConfig.overlays.hline.length > 0) {
                renderHorizontalLines(paneSurface.surface, paneSurface.wasm, paneConfig.overlays.hline, paneConfig.id);
              }
              
              // Render vertical lines
              if (paneConfig.overlays.vline && paneConfig.overlays.vline.length > 0) {
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
                
                // Reuse existing DataSeries if available (for orphaned series)
                if (shouldReuseDataSeries && existingEntryForReuse.dataSeries) {
                  dataSeries = existingEntryForReuse.dataSeries;
                
                } else {
                  // Create new DataSeries
                  if (renderableSeriesType === 'FastCandlestickRenderableSeries' || seriesInfo.type === 'ohlc-bar') {
                    dataSeries = new OhlcDataSeries(dataSeriesWasm, {
                      dataSeriesName: seriesId,
                      fifoCapacity: capacity,
                      capacity: capacity,
                      containsNaN: false,
                      dataIsSortedInX: true,
                      dataEvenlySpacedInX: false,
                    });
                  } else {
                    dataSeries = new XyDataSeries(dataSeriesWasm, {
                      dataSeriesName: seriesId,
                      fifoCapacity: capacity,
                      capacity: capacity,
                      containsNaN: false,
                      dataIsSortedInX: true,
                      dataEvenlySpacedInX: false,
                    });
                  }
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
                      resamplingMode: EResamplingMode.Auto,
                    });
                  } else {
                    renderableSeries = new FastLineRenderableSeries(wasm, {
                      dataSeries: dataSeries as XyDataSeries,
                      stroke: stroke,
                      strokeThickness: strokeThickness,
                      pointMarker: pointMarker,
                      resamplingMode: EResamplingMode.Auto,
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
          
          // Set resampling mode for all series - use Auto for better performance
          // Auto resampling significantly reduces CPU usage by rendering only visible pixels
          if (entry.renderableSeries instanceof FastLineRenderableSeries) {
            entry.renderableSeries.resamplingMode = EResamplingMode.Auto;
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
  const CHUNK_SIZE = 5000; // Process 5000 samples per frame to prevent blocking
  const processingQueueRef = useRef<Sample[]>([]);
  const isProcessingRef = useRef(false);
  
  // Buffer for samples that were skipped because series didn't exist yet
  // These will be reprocessed after series are created
  const skippedSamplesBufferRef = useRef<Sample[]>([]);
  const MAX_SKIPPED_BUFFER = 100000; // Keep up to 100k skipped samples for reprocessing
  
  // Process a single chunk of samples
  const processChunk = useCallback((samples: Sample[]) => {
    const refs = chartRefs.current;
    
    // Check if we have surfaces available
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    const hasLegacySurfaces = refs.tickSurface || refs.ohlcSurface;
    
    if (!hasDynamicPanes && !hasLegacySurfaces) {
      return;
    }
    
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
    const xyBatches = new Map<string, { x: number[], y: number[], entry: any }>();
    const ohlcBatches = new Map<string, { x: number[], o: number[], h: number[], l: number[], c: number[], entry: any }>();
    
    // First pass: group samples by series
    for (let i = 0; i < samplesLength; i++) {
      const sample = samples[i];
      const { series_id, t_ms, payload } = sample;
      
      if (t_ms > latestTime) {
        latestTime = t_ms;
      }

      // Get series entry from store (direct O(1) lookup)
      let seriesEntry = refs.dataSeriesStore.get(series_id);
      if (!seriesEntry) {
        // Series not preallocated yet - this can happen if data arrives before preallocation
        // Try to create it on-demand if panes are ready (fallback for timing issues)
        if (plotLayout && refs.paneSurfaces.size > 0 && isReady) {
          // Check if series is in layout - only create if it should be plotted
          const paneId = layoutManager?.getPaneForSeries(series_id);
          if (paneId) {
            const paneSurface = refs.paneSurfaces.get(paneId);
            if (paneSurface) {
              // Series is in layout and pane exists - create it on-demand
              console.log(`[MultiPaneChart] 🔧 Creating series on-demand: ${series_id} (data arrived before preallocation)`);
              const onDemandEntry = ensureSeriesExists(series_id);
              if (onDemandEntry) {
                seriesEntry = onDemandEntry;
              }
            }
          }
        }
        
        if (!seriesEntry) {
          // Still not found - buffer this sample for later reprocessing
          // Only buffer if series is in layout (don't buffer samples for series we'll never create)
          if (plotLayout && isSeriesInLayout(series_id)) {
            // Buffer sample for reprocessing after series is created
            if (skippedSamplesBufferRef.current.length < MAX_SKIPPED_BUFFER) {
              skippedSamplesBufferRef.current.push(sample);
            } else {
              // Buffer full - keep only most recent samples
              skippedSamplesBufferRef.current.shift(); // Remove oldest
              skippedSamplesBufferRef.current.push(sample);
            }
          }
          
          // DEBUG: Log missing series with detailed info (throttled - only first sample per batch)
          if (i === 0) {
            const bufferedCount = skippedSamplesBufferRef.current.length;
            console.warn(`[MultiPaneChart] ⚠️ Series not in store, buffering for later: ${series_id} (${bufferedCount} samples buffered)`);
            console.warn(`[MultiPaneChart] Available series in store (${refs.dataSeriesStore.size}):`, Array.from(refs.dataSeriesStore.keys()).slice(0, 10));
            console.warn(`[MultiPaneChart] Registry has ${registry.length} series:`, registry.map(r => r.id).slice(0, 10));
          }
          continue;
        }
      }
      
      // Track pane for overlay update
      if (seriesEntry.paneId) {
        panesWithData.add(seriesEntry.paneId);
      }

      // FAST TYPE DETECTION using string includes
      const isOhlc = series_id.includes(':ohlc_');
      
      if (isOhlc) {
        const o = payload.o as number;
        const h = payload.h as number;
        const l = payload.l as number;
        const c = payload.c as number;
        if (typeof o === 'number' && typeof h === 'number' && 
            typeof l === 'number' && typeof c === 'number') {
          let batch = ohlcBatches.get(series_id);
          if (!batch) {
            batch = { x: [], o: [], h: [], l: [], c: [], entry: seriesEntry };
            ohlcBatches.set(series_id, batch);
          }
          batch.x.push(t_ms);
          batch.o.push(o);
          batch.h.push(h);
          batch.l.push(l);
          batch.c.push(c);
        }
      } else {
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
            batch = { x: [], y: [], entry: seriesEntry };
            xyBatches.set(series_id, batch);
          }
          batch.x.push(t_ms);
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
      for (const [, batch] of xyBatches) {
        try {
          (batch.entry.dataSeries as XyDataSeries).appendRange(batch.x, batch.y);
        } catch (e) {}
      }
      
      for (const [, batch] of ohlcBatches) {
        try {
          (batch.entry.dataSeries as OhlcDataSeries).appendRange(batch.x, batch.o, batch.h, batch.l, batch.c);
        } catch (e) {}
      }
    } finally {
      // Resume all surfaces - this triggers a single batched redraw instead of N redraws
      for (const surface of suspendedSurfaces) {
        try { surface.resumeUpdates(); } catch (e) {}
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
                  minimapDataSeries.appendRange(validX, validY);
                  
                  // CRITICAL: Update minimap X-axis to show full data range after new data arrives
                  // The minimap should always show all data, not just the current selection
                  const minimapXAxis = (refs as any).minimapXAxis as DateTimeNumericAxis | null;
                  if (minimapXAxis && minimapDataSeries.count() > 0) {
                    try {
                      const fullDataRange = minimapDataSeries.getXRange();
                      if (fullDataRange) {
                        // Only update if the range has changed significantly (more than 1 second)
                        const currentRange = minimapXAxis.visibleRange;
                        if (!currentRange || 
                            Math.abs(currentRange.min - fullDataRange.min) > 1000 ||
                            Math.abs(currentRange.max - fullDataRange.max) > 1000) {
                          (refs as any).minimapSyncInProgress = true;
                          minimapXAxis.visibleRange = new NumberRange(fullDataRange.min, fullDataRange.max);
                          console.log(`[Minimap] Updated to show full data range after new data: ${new Date(fullDataRange.min).toISOString()} to ${new Date(fullDataRange.max).toISOString()}`);
                          setTimeout(() => {
                            (refs as any).minimapSyncInProgress = false;
                          }, 50);
                        }
                      }
                    } catch (e) {
                      console.warn('[MultiPaneChart] Error updating minimap X-axis range:', e);
                    }
                  }
                }
              }
            } catch (e) {
              console.error('[MultiPaneChart] Error updating minimap data:', e);
              // Don't throw - just log the error
            } finally {
              minimapSurface.resumeUpdates();
            }
          }
        } catch (e) {
          console.error('[MultiPaneChart] Error accessing minimap surface:', e);
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
    
    // Third pass: Create strategy marker annotations
    // Strategy markers are rendered as visual annotations (triangles/circles) in addition to line series
    // REQUIREMENT: Strategy markers must appear initially along with other series, not only when time window is selected
    // They should be rendered whenever samples arrive, regardless of time window selection
    if (plotLayout && refs.paneSurfaces.size > 0) {
      for (let i = 0; i < samplesLength; i++) {
        const sample = samples[i];
        const { series_id, t_ms, payload } = sample;
        
        // Only process strategy markers/signals
        if (!series_id.includes(':strategy:')) continue;
        if (!series_id.includes(':markers') && !series_id.includes(':signals')) continue;
        
        // Strategy marker series don't have dataSeriesStore entries (chartTarget: 'none')
        // They are rendered as annotations directly using strategyMarkerPanes from layout
        
        // Get all eligible panes for strategy markers
        const eligiblePanes = plotLayout.strategyMarkerPanes;
        
        for (const paneId of eligiblePanes) {
          const paneSurface = refs.paneSurfaces.get(paneId);
          if (!paneSurface || !paneSurface.surface) continue;
          
          // Get or create annotation pool for this pane
          let pool = refs.markerAnnotationPools.get(paneId);
          if (!pool) {
            pool = new MarkerAnnotationPool();
            refs.markerAnnotationPools.set(paneId, pool);
          }
          
          // Parse marker data - map server fields to expected format
          const markerData = parseMarkerFromSample({
            t_ms,
            v: (payload.price as number) || (payload.value as number) || 0,
            // Binary format: side, tag
            side: payload.side as string,
            tag: payload.tag as string,
            // JSON format: type, direction, label
            type: payload.type as string,
            direction: payload.direction as string,
            label: payload.label as string,
          }, series_id);
          
          // Skip invalid markers
          if (markerData.y === 0) continue;
          
          // Create unique key for this marker
          const markerKey = `${series_id}:${t_ms}`;
          
          try {
            // Get or create annotation
            const annotation = pool.getAnnotation(markerData, markerKey, paneSurface.wasm);
            
            // Add to surface if not already added
            if (!paneSurface.surface.annotations.contains(annotation)) {
              paneSurface.surface.annotations.add(annotation);
            }
          } catch (e) {
            // Silently ignore annotation creation errors
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
            }
            paneSurface.hasData = true;
            paneSurface.waitingForData = false;
          }
          updatePaneWaitingOverlay(refs, layoutManager, paneId, plotLayout);
        }
        
        // CRITICAL: If this is the first time data appears, force a full refresh
        // This ensures data appears on full reload (not just hot reload)
        if (firstDataReceived) {
          console.log(`[MultiPaneChart] 🎯 First data received, forcing full chart refresh`);
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
    
    // DEBUG: Log why auto-scroll is enabled/disabled (throttled to avoid spam)
    const logNow = performance.now();
    const lastLogTime = (window as any).__lastAutoScrollLogTime || 0;
    const shouldLog = logNow - lastLogTime > 2000; // Log every 2 seconds max
    
    if (shouldLog) {
      (window as any).__lastAutoScrollLogTime = logNow;
    }
    
    if (shouldLog && (hasSelectedWindow || minimapStickyRef.current)) {
      if (!autoScrollEnabled) {
        console.log(`[Auto-scroll] ❌ DISABLED - Flags:`, {
          ...debugFlags,
          reason: !isLiveRef.current ? 'isLiveRef=false' :
                  userInteractedRef.current ? 'userInteracted=true' :
                  settingTimeWindowRef.current ? 'settingTimeWindow=true' :
                  !minimapStickyRef.current && !hasSelectedWindow ? 'no sticky/minimap' :
                  'unknown'
        });
      } else {
        console.log(`[Auto-scroll] ✅ ENABLED - Flags:`, debugFlags);
      }
    }
    
    // CRITICAL: Allow auto-scroll if either feedStage is 'live' OR user explicitly enabled live mode
    // This ensures auto-scroll works immediately when live mode is toggled, even if feedStage hasn't reached 'live' yet
    const shouldRunAutoScroll = (isLive || isLiveRef.current) && autoScrollEnabled && latestTime > 0;
    
    if (shouldLog && !shouldRunAutoScroll && (hasSelectedWindow || minimapStickyRef.current)) {
      console.log(`[Auto-scroll] ⏸️ NOT RUNNING - Conditions:`, {
        isLive,
        isLiveRef: isLiveRef.current,
        autoScrollEnabled,
        latestTime,
        reason: !(isLive || isLiveRef.current) ? 'not in live mode' :
                !autoScrollEnabled ? 'autoScrollEnabled=false (see above)' :
                latestTime <= 0 ? 'no latestTime' :
                'unknown'
      });
    }
    
    if (shouldRunAutoScroll) {
      const now = performance.now();
      
      // CRITICAL: If a time window preset is selected, use that window size
      // Otherwise, use the stored minimap window width (from manual drag)
      let windowMs: number;
      if (hasSelectedWindow && selectedWindowMinutesRef.current !== null) {
        // Use the selected window size (convert minutes to milliseconds)
        windowMs = selectedWindowMinutesRef.current * 60 * 1000;
      } else {
        // Use the stored minimap window width (already in milliseconds)
        windowMs = minimapTimeWindowRef.current;
      }
      
      // CRITICAL: For time windows, use latestTime directly (much faster than iterating all series)
      // Only iterate through series if we don't have a time window selected
      const X_SCROLL_THRESHOLD = 100; // Small threshold (100ms) for minimap mode, no threshold for time windows
      const Y_AXIS_UPDATE_INTERVAL = 1000; // Update Y-axis every second
      
      let actualDataMax: number;
      let actualDataMin: number;
      
      if (hasSelectedWindow) {
        // For time windows, use latestTime directly - this is much faster
        actualDataMax = latestTime;
        actualDataMin = latestTime - windowMs;
      } else {
        // For minimap sticky mode, find actual data range (slower but more accurate)
        let min = Infinity;
        let max = 0;
        let hasData = false;
        for (const [, entry] of refs.dataSeriesStore) {
          try {
            if (entry.dataSeries.count() > 0) {
              const xRange = entry.dataSeries.getXRange();
              if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
                if (xRange.min < min) min = xRange.min;
                if (xRange.max > max) max = xRange.max;
                hasData = true;
              }
            }
          } catch (e) {}
        }
        
        if (!hasData) {
          actualDataMax = latestTime;
          actualDataMin = latestTime - windowMs;
        } else {
          actualDataMax = max;
          actualDataMin = min;
        }
      }
      
      // CRITICAL: Calculate new range with right edge at latest data (sticky behavior)
      // This ensures the window always shows the last X minutes from the latest data
      // Both actualDataMax and windowMs are in milliseconds
      const padding = windowMs * 0.02; // 2% padding on right edge
      const newRange = new NumberRange(actualDataMax - windowMs, actualDataMax + padding);

      // CRITICAL: Auto-scroll should ONLY update main chart panes
      // DO NOT update minimap directly - let the main-to-minimap subscription handle it
      // This prevents feedback loops and UI shaking
      // Manually sync to ALL panes since we're in sync mode (linked X-axes)
      // CRITICAL: If a time window is selected, preserve the locked state (disable autoRange, set growBy to zero)
      // Note: hasSelectedWindow is already declared above at line 4243
      (refs as any).mainChartSyncInProgress = true; // Block minimap-to-main sync during auto-scroll
      try {
        for (const [paneId, paneSurface] of refs.paneSurfaces) {
          if (paneSurface?.xAxis) {
            // CRITICAL: For time windows, always update (no threshold check) for smooth scrolling
            // For minimap sticky mode, use threshold to avoid excessive updates
            const currentMax = paneSurface.xAxis.visibleRange?.max || 0;
            const diff = Math.abs(currentMax - newRange.max);
            const X_SCROLL_THRESHOLD = 100; // Small threshold (100ms) for minimap mode
            const shouldUpdate = hasSelectedWindow || !paneSurface.xAxis.visibleRange || diff > X_SCROLL_THRESHOLD;
            
            if (shouldUpdate) {
              // CRITICAL: Always lock the X-axis when auto-scrolling (disable autoRange, set growBy to zero)
              // This prevents SciChart from auto-scaling and overriding our range
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
        
        // The main-to-minimap subscription will automatically update minimap
        // No need to update minimap directly here
      } finally {
        // Clear flag after a short delay to allow minimap to sync
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
      
      // Update Y-axes periodically
      if (now - lastYAxisUpdateRef.current >= Y_AXIS_UPDATE_INTERVAL) {
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
    
    const processNextChunk = () => {
      if (processingQueueRef.current.length === 0) {
        isProcessingRef.current = false;
        return;
      }
      
      // Take next chunk
      const chunk = processingQueueRef.current.splice(0, CHUNK_SIZE);
      
      // Process this chunk
      processChunk(chunk);
      
      // If more samples in queue, schedule next chunk with setTimeout(0)
      // This yields to the browser, preventing UI freeze
      if (processingQueueRef.current.length > 0) {
        setTimeout(processNextChunk, 0);
      } else {
        isProcessingRef.current = false;
      }
    };
    
    // Start processing first chunk
    processNextChunk();
  }, [processChunk]);
  
  // Track feed stage changes and handle transitions
  // OPTIMIZED: Non-blocking live transition to prevent UI freezes
  useEffect(() => {
    const prevStage = feedStageRef.current;
    feedStageRef.current = feedStage;
    
    // Reset history loaded flag when starting new connection
    if (feedStage === 'history' && prevStage === 'idle') {
      historyLoadedRef.current = false;
      initialDataTimeRef.current = null;
      return;
    }
    
    // CRITICAL: Auto-zoom extents during history/delta mode to show latest data as it loads
    // This mimics the Z key behavior automatically during history/delta loading
    // Uses requestAnimationFrame for smooth updates (same as continuous Z key presses)
    if (feedStage === 'history' || feedStage === 'delta') {
      let animationFrameId: number | null = null;
      let lastZoomTime = 0;
      const ZOOM_THROTTLE_MS = 100; // Throttle to 100ms for smooth but not excessive updates
      
      const performAutoZoom = () => {
        const now = performance.now();
        
        // Throttle zoom calls to avoid excessive updates
        if (now - lastZoomTime < ZOOM_THROTTLE_MS) {
          animationFrameId = requestAnimationFrame(performAutoZoom);
          return;
        }
        
        if ((feedStageRef.current === 'history' || feedStageRef.current === 'delta') && isReady) {
          // Only zoom if we have data and chart is ready
          let hasData = false;
          for (const [, entry] of chartRefs.current.dataSeriesStore) {
            if (entry.dataSeries && entry.dataSeries.count() > 0) {
              hasData = true;
              break;
            }
          }
          
          if (hasData) {
            // Call zoomExtents directly on all surfaces for smooth updates
            for (const [paneId, paneSurface] of chartRefs.current.paneSurfaces) {
              try {
                paneSurface.surface.zoomExtents();
              } catch (e) {
                // Silently ignore errors during rapid updates
              }
            }
            // Also zoom legacy surfaces if they exist
            try {
              chartRefs.current.tickSurface?.zoomExtents();
              chartRefs.current.ohlcSurface?.zoomExtents();
            } catch (e) {
              // Silently ignore errors
            }
            
            lastZoomTime = now;
          }
          
          // Continue the animation loop
          animationFrameId = requestAnimationFrame(performAutoZoom);
        } else {
          // Stop if we're no longer in history/delta mode
          animationFrameId = null;
        }
      };
      
      // Start the animation loop
      animationFrameId = requestAnimationFrame(performAutoZoom);
      
      return () => {
        if (animationFrameId !== null) {
          cancelAnimationFrame(animationFrameId);
          animationFrameId = null;
        }
      };
    }
    
    // When transitioning to live, set X-axis range to show latest data
    // CRITICAL: Use requestIdleCallback/setTimeout to avoid blocking UI
    if (feedStage === 'live' && prevStage !== 'live') {
      historyLoadedRef.current = true;
      
      // Use setTimeout(0) to defer heavy work and prevent UI freeze
      setTimeout(() => {
        const refs = chartRefs.current;
        
        // Collect all surfaces to update
        const surfaces: SciChartSurface[] = [];
        if (refs.tickSurface) surfaces.push(refs.tickSurface);
        if (refs.ohlcSurface) surfaces.push(refs.ohlcSurface);
        for (const [, paneSurface] of refs.paneSurfaces) {
          if (paneSurface.surface) surfaces.push(paneSurface.surface);
        }
        
        if (surfaces.length === 0) return;
        
        // CRITICAL: Suspend ALL surfaces first to prevent multiple redraws
        for (const surface of surfaces) {
          try { surface.suspendUpdates(); } catch (e) { /* ignore */ }
        }
        
        try {
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
            // No data yet - schedule retry
            setTimeout(() => {
              triggerYAxisScalingOnNextBatchRef.current = true;
            }, 200);
            return;
          }
          
          // Calculate X-axis range
          let liveRange: NumberRange;
          const defaultRange = plotLayout?.xAxisDefaultRange;
          const calculatedRange = defaultRange 
            ? calculateDefaultXAxisRange(defaultRange, dataMax, dataMin, dataMax)
            : null;
          
          if (calculatedRange) {
            liveRange = calculatedRange;
          } else {
            // Default: 2 minute window focused on latest data
            const windowMs = 2 * 60 * 1000;
            const padding = 10 * 1000;
            liveRange = new NumberRange(dataMax - windowMs, dataMax + padding);
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
          const refs = chartRefs.current;
          
          // Suspend again for Y-axis updates
          const surfacesToUpdate: SciChartSurface[] = [];
          if (refs.tickSurface) surfacesToUpdate.push(refs.tickSurface);
          if (refs.ohlcSurface) surfacesToUpdate.push(refs.ohlcSurface);
          for (const [, paneSurface] of refs.paneSurfaces) {
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
        
      }, 0); // setTimeout(0) defers to next tick, preventing blocking
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
        // Tab is becoming visible - ALWAYS jump to latest data (requirement)
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
                  
                  // Process data silently in background (skipChartRendering is still true)
                  const processRemaining = async () => {
                    let iterations = 0;
                    const maxIterations = 10000; // Process all remaining data
                    const chunkSize = 50; // Process 50 batches, then yield
                    
                    while (sampleBufferRef.current.length > 0 && iterations < maxIterations) {
                      // Process a chunk of batches
                      for (let i = 0; i < chunkSize && sampleBufferRef.current.length > 0 && iterations < maxIterations; i++) {
                        processBatchedSamples(); // Will skip rendering during restoration
                        iterations++;
                      }
                      
                      // Yield to browser every chunk to prevent blocking
                      if (sampleBufferRef.current.length > 0 && iterations < maxIterations) {
                        await new Promise(resolve => setTimeout(resolve, 1)); // 1ms delay
                      }
                    }
                    
                
                  };
                  
                  // Start background processing (don't await)
                  processRemaining();
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
  }, [processBatchedSamples]);

  // Append samples with batching - ALWAYS collect data even when paused
  // Data collection continues in background per UI config
  const appendSamples = useCallback((samples: Sample[]) => {
    if (samples.length === 0) return;
    
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
    
    // Only schedule processing if we have series ready to receive data
    // Otherwise, samples will stay in sampleBufferRef until series are created
    if (pendingUpdateRef.current === null && (hasSeries || isReady)) {
      // Use requestAnimationFrame for smooth 60fps rendering
      // Unlike the previous complex scheduling, just use RAF consistently
      pendingUpdateRef.current = requestAnimationFrame(() => {
        pendingUpdateRef.current = null;
        processBatchedSamples();
      });
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
    // Zoom all dynamic pane surfaces
    for (const [paneId, paneSurface] of chartRefs.current.paneSurfaces) {
      try {
        paneSurface.surface.zoomExtents();
        console.log(`[zoomExtents] Zoomed pane: ${paneId}`);
      } catch (e) {
        console.warn(`[zoomExtents] Failed to zoom pane ${paneId}:`, e);
      }
    }
    
    // Also zoom legacy surfaces if they exist
    chartRefs.current.tickSurface?.zoomExtents();
    chartRefs.current.ohlcSurface?.zoomExtents();
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
    timeWindowSelectedRef.current = false;
    selectedWindowMinutesRef.current = null; // Clear selected window to allow normal live mode
    minimapStickyRef.current = true; // Enable sticky mode for live following
    settingTimeWindowRef.current = false; // Clear any stuck flag
    
    // Clear any pending interaction timeout
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current);
      interactionTimeoutRef.current = null;
    }
    
    // Update X-axis ranges to show latest data
    const lastTime = lastDataTimeRef.current;
    if (lastTime > 0) {
      const windowMs = 5 * 60 * 1000;
      const newRange = new NumberRange(lastTime - windowMs, lastTime + windowMs * 0.05);
      
      // Update all dynamic panes
      for (const [, paneSurface] of chartRefs.current.paneSurfaces) {
        if (paneSurface?.xAxis) {
          try {
            (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
            paneSurface.xAxis.growBy = new NumberRange(0, 0);
            paneSurface.xAxis.visibleRange = newRange;
            paneSurface.surface.invalidateElement();
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
          tickXAxis.visibleRange = newRange;
          chartRefs.current.tickSurface?.invalidateElement();
        } catch (e) {}
      }
      if (ohlcXAxis) {
        try {
          (ohlcXAxis as any).autoRange = EAutoRange.Never;
          ohlcXAxis.growBy = new NumberRange(0, 0);
          ohlcXAxis.visibleRange = newRange;
          chartRefs.current.ohlcSurface?.invalidateElement();
        } catch (e) {}
      }
      
      // Update minimap range selection (OverviewRangeSelectionModifier) if it exists
      const rangeSelectionModifier = (chartRefs.current as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
      if (rangeSelectionModifier) {
        try {
          rangeSelectionModifier.selectedArea = newRange;
        } catch (e) {}
      }
      
      console.log(`[jumpToLive] ✅ Completed - New flags AFTER:`, {
        isLiveRef: isLiveRef.current,
        userInteractedRef: userInteractedRef.current,
        minimapStickyRef: minimapStickyRef.current,
        settingTimeWindowRef: settingTimeWindowRef.current,
        selectedWindowMinutes: selectedWindowMinutesRef.current,
      });
    } else {
      console.warn(`[jumpToLive] ⚠️ No lastDataTime available: ${lastDataTimeRef.current}`);
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
      // Zero or negative means show all data (zoom extents for minimap)
      // Disable sticky mode
      minimapStickyRef.current = false;
      timeWindowSelectedRef.current = false; // Clear time window flag for "Entire Session"
      selectedWindowMinutesRef.current = null; // Clear selected window size
      zoomExtents();
      return;
    }
    
    // Store the selected window size so we can continuously update it in live mode
    // This ensures the window always shows the last X minutes from the latest data
    selectedWindowMinutesRef.current = minutes;
    
    // CRITICAL: Set flag to prevent auto-scroll from overriding during setTimeWindow
    settingTimeWindowRef.current = true;

    // CRITICAL: Use the actual latest data timestamp, not the passed dataClockMs
    // This ensures the time window includes all available data
    // Use lastDataTimeRef as primary source, fallback to dataClockMs, then Date.now()
    const actualLatestTime = lastDataTimeRef.current > 0 
      ? lastDataTimeRef.current 
      : (dataClockMs > 0 ? dataClockMs : Date.now());
    
    const windowMs = minutes * 60 * 1000;
    // CRITICAL: Data is stored in milliseconds (t_ms), so X-axis range must also be in milliseconds
    // DateTimeNumericAxis can handle milliseconds directly (as shown in reference code)
    const endMs = actualLatestTime; // Keep in milliseconds
    const startMs = endMs - windowMs;
    const padding = windowMs * 0.02; // 2% padding on right edge
    const newRange = new NumberRange(startMs, endMs + padding);
    
    console.log(`[setTimeWindow] Setting ${minutes} min window using latest timestamp ${actualLatestTime}: ${new Date(startMs).toISOString()} - ${new Date(endMs).toISOString()}`);
    console.log(`[setTimeWindow] Window range in ms: ${startMs} to ${endMs + padding} (window size: ${windowMs}ms = ${minutes} minutes)`);
    console.log(`[setTimeWindow] Current time: ${new Date().toISOString()}, Latest data time: ${new Date(actualLatestTime).toISOString()}`);

    // Store the window size for sticky mode auto-scroll
    minimapTimeWindowRef.current = windowMs;
    
    // Clear any pending interaction timeout
    if (interactionTimeoutRef.current) {
      clearTimeout(interactionTimeoutRef.current);
      interactionTimeoutRef.current = null;
    }

    // CRITICAL: Update X-axis ranges FIRST, before updating minimap selection
    // This ensures all series are visible in the new range before the minimap updates
    // REQUIREMENT: Only change X-axis range - do NOT affect series visibility
    console.log(`[setTimeWindow] Setting X-axis range on all panes FIRST: ${newRange.min} to ${newRange.max} (${new Date(newRange.min).toISOString()} to ${new Date(newRange.max).toISOString()})`);
    
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
        
        // CRITICAL: Verify the range was actually set after minimap sync completes
        // Wait longer to ensure minimap callback doesn't override it
        setTimeout(() => {
          // Skip verification if minimap is still syncing
          if ((refs as any).minimapSyncInProgress) {
            return;
          }
          const actualRange = paneSurface.xAxis.visibleRange;
          if (actualRange) {
            const diff = Math.abs(actualRange.min - newRange.min) + Math.abs(actualRange.max - newRange.max);
            if (diff > 1000) { // More than 1 second difference
              console.warn(`[setTimeWindow] ⚠️ X-axis range was changed after setting! Expected: ${newRange.min}-${newRange.max}, Actual: ${actualRange.min}-${actualRange.max}`);
              // Force it again, and also update minimap to match
              (paneSurface.xAxis as any).autoRange = EAutoRange.Never;
              try {
                paneSurface.xAxis.growBy = new NumberRange(0, 0);
              } catch (e) {
                (paneSurface.xAxis as any).growBy = new NumberRange(0, 0);
              }
              paneSurface.xAxis.visibleRange = newRange;
              paneSurface.surface.invalidateElement();
              
              // Also update minimap X-axis to match (official SubCharts pattern)
              const minimapXAxis = (refs as any).minimapXAxis as DateTimeNumericAxis | null;
              if (minimapXAxis) {
                (refs as any).minimapSyncInProgress = true;
                minimapXAxis.visibleRange = newRange;
                setTimeout(() => {
                  (refs as any).minimapSyncInProgress = false;
                }, 100);
              }
            }
          }
        }, 150); // Wait for minimap sync to complete, but not too long to avoid blocking auto-scroll
        
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
    }, 0); // Use setTimeout to ensure all range changes are applied before resuming
    
    // Update minimap range selection (OverviewRangeSelectionModifier)
    const rangeSelectionModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
    if (rangeSelectionModifier) {
      try {
        rangeSelectionModifier.selectedArea = newRange;
      } catch (e) {
        console.warn('[setTimeWindow] Error updating minimap range selection:', e);
      }
    }
    
    // CRITICAL: setTimeWindow should ONLY change the X-axis range
    // DO NOT modify auto-scroll flags here - let the existing auto-scroll logic handle it
    // The auto-scroll will detect the selected window and update it appropriately
    // Mark that a time window was selected (for auto-scroll to use)
    timeWindowSelectedRef.current = true;
    
    // Notify parent component to update Toolbar display
    if (onTimeWindowChanged) {
      onTimeWindowChanged({
        minutes,
        startTime: startMs,
        endTime: endMs + padding,
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

  return {
    isReady,
    appendSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
    setTimeWindow,
    chartRefs,
    handleGridReady,
  };
}
