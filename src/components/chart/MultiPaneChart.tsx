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
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  ECoordinateMode,
  // For standalone minimap with range selection
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
  
  // DISABLED: Helper to create a series on-demand - causes WASM abort errors
  // Series should only be created via preallocation when surfaces are ready
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const ensureSeriesExists = (seriesId: string): DataSeriesEntry | null => {
    // This function is disabled to prevent WASM abort errors
    // All series creation should happen via preallocation
    // ensureSeriesExists called unexpectedly
    return null;
    const refs = chartRefs.current;
    
    // Check if already exists
    if (refs.dataSeriesStore.has(seriesId)) {
      return refs.dataSeriesStore.get(seriesId)!;
    }
    
    // CRITICAL: Don't create series on-demand if layout is loaded but panes aren't ready yet
    // This prevents WASM abort errors when trying to create series before panes exist
    if (plotLayout && refs.paneSurfaces.size === 0) {
      // Layout is loaded but panes aren't created yet - wait for panes to be ready
      // Cannot create series on-demand: panes not ready yet
      return null;
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
      const entry: DataSeriesEntry = {
        dataSeries,
        renderableSeries,
        chartTarget: (seriesInfo.chartTarget === 'none' ? 'tick' : seriesInfo.chartTarget) as 'tick' | 'ohlc', // Safe cast: we only create for plotted series
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
  const historyLoadedRef = useRef(false);
  const initialDataTimeRef = useRef<number | null>(null);
  const userInteractedRef = useRef(false);
  const lastDataTimeRef = useRef(0);
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

        // Only link X-axes if config says to share them (default: separate)
        let verticalGroup: SciChartVerticalGroup | null = null;
        if (!config.chart.separateXAxes) {
          verticalGroup = new SciChartVerticalGroup();
        verticalGroup.addSurfaceToGroup(tickSurface);
        verticalGroup.addSurfaceToGroup(ohlcSurface);
        }

        // FPS tracking is now handled by requestAnimationFrame at the top level
        // No need to subscribe to surface rendered events

        // User interaction detection
        const markInteracted = () => {
          userInteractedRef.current = true;
          if (interactionTimeoutRef.current) {
            clearTimeout(interactionTimeoutRef.current);
          }
          interactionTimeoutRef.current = setTimeout(() => {
            userInteractedRef.current = false;
          }, 10000);
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
  }, [tickContainerId, ohlcContainerId, plotLayout]);

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
              ((refs as any).minimapSurface as SciChartSurface).delete();
            } catch (e) {
              console.warn('[MultiPaneChart] Error deleting old minimap surface:', e);
            }
            (refs as any).minimapSurface = null;
          }
          
          // Get data from dataSeriesStore for the minimap source series
          if (!minimapSourceSeriesId) {
            console.warn('[MultiPaneChart] No minimap source series specified in layout');
            return;
          }
          
          const seriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
          if (!seriesEntry || !seriesEntry.dataSeries) {
            console.log('[MultiPaneChart] Minimap source series not found in dataSeriesStore, will retry on refresh');
            return;
          }
          
          // Check if source series has data
          const sourceDataSeries = seriesEntry.dataSeries as XyDataSeries;
          const pointCount = sourceDataSeries.count();
          if (pointCount === 0) {
            console.log('[MultiPaneChart] Minimap source series has no data yet, will retry on refresh');
            return;
          }
          
          // Create standalone minimap surface
          const { sciChartSurface: minimapSurface, wasmContext: minimapWasm } = await SciChartSurface.create(overviewContainerId, {
            theme: chartTheme,
          });
          
          if (isCancelled) {
            minimapSurface.delete();
            return;
          }
          
          // Configure axes for minimap
          const xAxis = new DateTimeNumericAxis(minimapWasm, {
            axisTitle: '',
            drawLabels: false,
            drawMinorTickLines: false,
            drawMajorTickLines: false,
            drawMajorGridLines: false,
            drawMinorGridLines: false,
            autoRange: EAutoRange.Always,
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
          
          // Create cloned DataSeries by copying from source
          const clonedDataSeries = new XyDataSeries(minimapWasm, {
            fifoCapacity: pointCount + 100000,
            isSorted: true,
            containsNaN: false,
          });
          
          // Copy data from source DataSeries to cloned series
          const nativeX = sourceDataSeries.getNativeXValues();
          const nativeY = sourceDataSeries.getNativeYValues();
          
          let copiedCount = 0;
          if (nativeX.size() > 0) {
            // Convert to arrays and append
            const xArr: number[] = [];
            const yArr: number[] = [];
            for (let i = 0; i < nativeX.size(); i++) {
              xArr.push(nativeX.get(i));
              yArr.push(nativeY.get(i));
            }
            clonedDataSeries.appendRange(xArr, yArr);
            copiedCount = xArr.length;
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
          
          // Add OverviewRangeSelectionModifier for proper minimap behavior with range selection box
          const rangeSelectionModifier = new OverviewRangeSelectionModifier({
            onSelectedAreaChanged: (area?: NumberRange) => {
              if (!area) return;
              
              // Skip if this update came from syncing TO minimap (prevent infinite loop)
              if ((refs as any).minimapSyncInProgress) return;
              
              // Sync minimap selection to ONLY the target pane (the one containing minimap source series)
              (refs as any).mainChartSyncInProgress = true;
              try {
                const storedTargetPaneId = (refs as any).minimapTargetPaneId;
                if (storedTargetPaneId) {
                  const paneSurface = refs.paneSurfaces.get(storedTargetPaneId);
                  if (paneSurface?.xAxis) {
                    paneSurface.xAxis.visibleRange = new NumberRange(area.min, area.max);
                  }
                }
                
                // When user drags minimap selection, pause live mode
                isLiveRef.current = false;
                userInteractedRef.current = true;
              } finally {
                (refs as any).mainChartSyncInProgress = false;
              }
            },
          });
          
          // Set initial selected area if available
          if (initialSelectedArea) {
            rangeSelectionModifier.selectedArea = initialSelectedArea;
          }
          
          minimapSurface.chartModifiers.add(rangeSelectionModifier);
          
          // Store reference for updates and cleanup
          (refs as any).minimapSurface = minimapSurface;
          (refs as any).minimapDataSeries = clonedDataSeries;
          (refs as any).minimapSourceSeriesId = minimapSourceSeriesId;
          (refs as any).minimapTargetPaneId = targetPaneId; // Store target pane ID for syncing
          (refs as any).minimapRangeSelectionModifier = rangeSelectionModifier;
          
          lastOverviewSourceRef.current = {
            surfaceId: minimapSurface.id,
            minimapSourceSeries: minimapSourceSeriesId
          };
          
          console.log('[MultiPaneChart] Standalone minimap created with', copiedCount, 'points and range selection');
          
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
        (refs as any).minimapRangeSelectionModifier = null;
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

  // Preallocate DataSeries when new series are discovered in registry
  // This ensures buffers are ready before data arrives (proactive preallocation)
  useEffect(() => {
    const refs = chartRefs.current;
    
    // Check if we have either legacy surfaces OR dynamic panes
    const hasLegacySurfaces = refs.tickSurface && refs.ohlcSurface && refs.tickWasm && refs.ohlcWasm;
    const hasDynamicPanes = plotLayout && refs.paneSurfaces.size > 0;
    
    if (!hasLegacySurfaces && !hasDynamicPanes) {
      console.log('[MultiPaneChart] Preallocation skipped: no surfaces ready');
      return;
    }
    if (!registry || registry.length === 0) {
      console.log('[MultiPaneChart] Preallocation skipped: registry empty');
      return;
    }

    // CRITICAL: For dynamic panes, ensure panes are created before preallocating
    if (plotLayout && refs.paneSurfaces.size === 0) {
      console.warn('[MultiPaneChart] ⚠️ Preallocation skipped: dynamic panes not created yet', {
        registryLength: registry.length,
        plotLayoutPanes: plotLayout.layout.panes.length,
        paneSurfacesCount: refs.paneSurfaces.size
      });
      return;
    }
    if (!isReady) {
      console.log('[MultiPaneChart] Preallocation skipped: chart not ready');
      return; // Wait for charts to be initialized
    }
    
    // Early return: Check if all series in registry are already preallocated
    // This prevents unnecessary re-runs when nothing has changed
    const registrySeriesIds = new Set(registry.map(r => r.id));
    const preallocatedSeriesIds = new Set(Array.from(refs.dataSeriesStore.keys()).filter(id => {
      const entry = refs.dataSeriesStore.get(id);
      return entry && entry.renderableSeries && entry.paneId; // Fully created series
    }));
    
    // Check if all registry series are already preallocated
    const allPreallocated = registry.every(regEntry => {
      const seriesId = regEntry.id;
      const seriesInfo = parseSeriesType(seriesId);
      if (seriesInfo.chartTarget === 'none') return true; // Skip non-chart series
      return preallocatedSeriesIds.has(seriesId);
    });
    
    if (allPreallocated && registry.length > 0) {
      // All series are already preallocated, skip this run
      return;
    }
    
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
      if (seriesInfo.chartTarget === 'none') return;
      
      // IMPORTANT: Silently skip series not defined in the layout
      // This prevents console errors for server-sent series that user doesn't want to visualize
      if (!isSeriesInLayout(seriesId)) {
        // Series not in layout - silently skip (layout is single source of truth)
        return;
      }
      
      try {
        // Get pane and surface using layout manager or fallback
        const { paneId, surface, wasm } = getPaneForSeries(seriesId);
        
        if (!wasm || !surface || !paneId) {
          // Pane defined in layout but surface not ready yet - this is expected during initialization
          // Only log if we have panes but this specific one is missing
          if (refs.paneSurfaces.size > 0 && paneId) {
            console.warn(`[MultiPaneChart] Surface for pane "${paneId}" not ready yet for series ${seriesId}`);
          }
          return;
        }
        
        // Mark as preallocated to prevent duplicate creation
        preallocatedSeriesRef.current.add(seriesId);
        
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
        surface.renderableSeries.add(renderableSeries);
        
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
        console.warn(`[MultiPaneChart] Failed to preallocate DataSeries for ${seriesId}:`, e);
      }
    });
    
    // Invalidate surfaces to ensure new series are rendered
    // CRITICAL: Only invalidate if we actually created new series to prevent unnecessary rerenders
    if (newSeriesCount > 0) {
      if (refs.tickSurface) {
        refs.tickSurface.invalidateElement();
      }
      if (refs.ohlcSurface) {
        refs.ohlcSurface.invalidateElement();
      }
      // Invalidate all dynamic panes
      for (const [paneId, paneSurface] of refs.paneSurfaces) {
        paneSurface.surface.invalidateElement();
      }
      
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
  }, [registry, visibleSeries, isReady, plotLayout]);

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

          // CRITICAL: Clear dataSeriesStore entries that have renderableSeries
          // The renderableSeries will be destroyed when panes are destroyed
          // but we need to clear the store so series can be recreated
          for (const [seriesId, entry] of refs.dataSeriesStore.entries()) {
            if (entry.renderableSeries) {
              // Keep the DataSeries (which holds data) but clear the entry
              // so it can be recreated with a new renderableSeries
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
          }, 400);
        });
      }

      // Reset all state flags
      dynamicPanesInitializedRef.current = false;
      parentSurfaceReadyRef.current = false;
      pendingPaneCreationRef.current = false;
      currentLayoutIdRef.current = null;
      setParentSurfaceReady(false);

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
                // Just pause auto-scroll
                isLiveRef.current = false;
                userInteractedRef.current = true;
              });
              
              // Add user interaction detection for pan/zoom to sync minimap
              // Use mouseup/touchend to capture final range after drag completes
              // Only sync if this pane is the minimap's target pane
              const syncMinimapSelection = () => {
                // Use setTimeout to ensure the axis range has been updated
                setTimeout(() => {
                  const refs = chartRefs.current;
                  if ((refs as any).mainChartSyncInProgress) return;
                  
                  // Only sync from the target pane (the one linked to minimap)
                  const minimapTargetPaneId = (refs as any).minimapTargetPaneId;
                  if (minimapTargetPaneId && minimapTargetPaneId !== paneConfig.id) return;
                  
                  const rangeModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
                  if (rangeModifier && paneSurface.xAxis?.visibleRange) {
                    try {
                      (refs as any).minimapSyncInProgress = true;
                      rangeModifier.selectedArea = new NumberRange(
                        paneSurface.xAxis.visibleRange.min,
                        paneSurface.xAxis.visibleRange.max
                      );
                    } catch (e) {
                      // Ignore sync errors
                    } finally {
                      (refs as any).minimapSyncInProgress = false;
                    }
                  }
                }, 50);
              };
              
              // Sync on mouseup (after drag completes) and on wheel (immediate)
              surfaceElement.addEventListener('mouseup', syncMinimapSelection, { passive: true });
              surfaceElement.addEventListener('touchend', syncMinimapSelection, { passive: true });
              surfaceElement.addEventListener('wheel', syncMinimapSelection, { passive: true });
            }
            
            // Store shared WASM from first pane and create vertical group
            if (!refs.sharedWasm) {
              refs.sharedWasm = paneSurface.wasm;
              
              // Create vertical group if needed
              if (!refs.verticalGroup && !config.chart.separateXAxes) {
                const vGroup = paneManager.createVerticalGroup(paneSurface.wasm);
                refs.verticalGroup = vGroup;
              }
            }
            
            // Add to vertical group to link X-axes across all panes
            // Requirement 17: All panes must have their own X-axis, all linked and synchronized
            // Note: separateXAxes config is kept for backward compatibility but all panes are linked
            if (refs.verticalGroup) {
              try {
                refs.verticalGroup.addSurfaceToGroup(paneSurface.surface);
              } catch (e) {
                // Ignore if already in group
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

        // Set isReady after creating panes OR if parent surface is ready (for dynamic layouts)
        // This ensures the "Initializing Chart" overlay is removed
        if (!isReady) {
          console.log('[MultiPaneChart] Setting isReady = true');
          setIsReady(true);
          onReadyChange?.(true);
        }
        
        // CRITICAL: Trigger overview refresh after panes are created
        // This ensures the minimap recreates with the new source surface
        // Use a small delay to ensure series have been added to surfaces
        setTimeout(() => {
          console.log('[MultiPaneChart] Triggering overview refresh after pane creation');
          setOverviewNeedsRefresh(prev => prev + 1);
        }, 500);
        
        // CRITICAL: After all panes are created, manually trigger preallocation for any series in registry
        // This ensures series are created immediately when panes are ready, even if the useEffect hasn't run yet
       
        
        // Always try to trigger preallocation after panes are created, even if registry is empty
        // The registry might populate later, and we want to be ready
        if (refs.paneSurfaces.size === plotLayout.layout.panes.length) {
          if (registry.length > 0) {
           
          } else {
           
          }
          
          // Always set up the trigger, even if registry is empty (it will run when registry populates)
          if (registry.length > 0) {
          
          // Use setTimeout to ensure this runs after the current execution context
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
        
            } else if (registry.length > 0) {
              console.warn(`[MultiPaneChart] ⚠️ No series were created after pane creation (registry has ${registry.length} series, dataSeriesStore has ${refs.dataSeriesStore.size} series)`);
            }
          }, 100); // Small delay to ensure all panes are registered
          }
        } else {
         
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
      const seriesEntry = refs.dataSeriesStore.get(series_id);
      if (!seriesEntry) {
        // DEBUG: Log missing series (throttled - only first sample per batch)
        if (i === 0) {
          console.warn(`[MultiPaneChart] Series not in store, skipping: ${series_id}. Available: ${Array.from(refs.dataSeriesStore.keys()).slice(0, 5).join(', ')}...`);
        }
        continue;
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
              minimapDataSeries.appendRange(minimapBatch.x, minimapBatch.y);
            } finally {
              minimapSurface.resumeUpdates();
            }
          }
        } catch (e) {
          // Ignore minimap update errors
        }
      }
    }
    
    // Third pass: Create strategy marker annotations
    // Strategy markers are rendered as visual annotations (triangles/circles) in addition to line series
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
    if (panesWithData.size > 0) {
      requestAnimationFrame(() => {
        for (const paneId of panesWithData) {
          const paneSurface = refs.paneSurfaces.get(paneId);
          if (paneSurface) {
            paneSurface.hasData = true;
            paneSurface.waitingForData = false;
          }
          updatePaneWaitingOverlay(refs, layoutManager, paneId, plotLayout);
        }
      });
    }

    // Skip auto-scroll during range restoration
    if (isRestoringRangeRef.current) {
      return;
    }
    
    // Auto-scroll logic (only in live mode)
    const isLive = feedStage === 'live';
    const autoScrollEnabled = isLiveRef.current && !userInteractedRef.current;
    
    if (isLive && autoScrollEnabled && latestTime > 0) {
      const now = performance.now();
      const windowMs = 300 * 1000; // 5 minutes window (matching new-index.html)
      const X_SCROLL_THRESHOLD = 5000; // 5 seconds threshold
      const Y_AXIS_UPDATE_INTERVAL = 1000; // Update Y-axis every second
      
      // Find actual data min and max from DataSeries
      let actualDataMin = Infinity;
      let actualDataMax = 0;
      let hasData = false;
      for (const [, entry] of refs.dataSeriesStore) {
        try {
          if (entry.dataSeries.count() > 0) {
            const xRange = entry.dataSeries.getXRange();
            if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
              if (xRange.min < actualDataMin) actualDataMin = xRange.min;
              if (xRange.max > actualDataMax) actualDataMax = xRange.max;
              hasData = true;
            }
          }
        } catch (e) {}
      }
      
      if (!hasData) {
        actualDataMax = latestTime;
        actualDataMin = latestTime - windowMs;
      }
      
      // Check if layout specifies "session" mode - show all data from start to end
      const defaultRangeMode = plotLayout?.xAxisDefaultRange?.mode;
      const isSessionMode = defaultRangeMode === 'session';
      
      let newRange: NumberRange;
      if (isSessionMode && hasData) {
        // Session mode: always show entire data range from first to last point
        const padding = (actualDataMax - actualDataMin) * 0.02; // 2% padding
        newRange = new NumberRange(actualDataMin - padding, actualDataMax + padding);
      } else {
        // Default: fixed time window scrolling with latest data
        const padding = 10 * 1000;
        newRange = new NumberRange(actualDataMax - windowMs, actualDataMax + padding);
      }
      
      // Update all X-axes
      const axesToUpdate: Array<{ axis: any; surface: any }> = [];
      
      if (refs.tickSurface?.xAxes.get(0)) {
        axesToUpdate.push({ axis: refs.tickSurface.xAxes.get(0), surface: refs.tickSurface });
      }
      if (refs.ohlcSurface?.xAxes.get(0)) {
        axesToUpdate.push({ axis: refs.ohlcSurface.xAxes.get(0), surface: refs.ohlcSurface });
      }
      for (const [, paneSurface] of refs.paneSurfaces) {
        if (paneSurface.xAxis) {
          axesToUpdate.push({ axis: paneSurface.xAxis, surface: paneSurface.surface });
        }
      }
      
      for (const { axis, surface } of axesToUpdate) {
        try {
          const currentMax = axis.visibleRange?.max || 0;
          const diff = Math.abs(currentMax - newRange.max);
          if (!axis.visibleRange || diff > X_SCROLL_THRESHOLD) {
            axis.visibleRange = newRange;
            surface?.invalidateElement();
          }
        } catch (e) {}
      }
      
      // Sync minimap selection to follow main chart X-axis (when in live mode auto-scrolling)
      // Only if not already syncing from minimap to prevent infinite loop
      if (!(refs as any).mainChartSyncInProgress) {
        const rangeModifier = (refs as any).minimapRangeSelectionModifier as OverviewRangeSelectionModifier | null;
        if (rangeModifier) {
          try {
            (refs as any).minimapSyncInProgress = true;
            rangeModifier.selectedArea = newRange;
            (refs as any).minimapSyncInProgress = false;
          } catch (e) {
            (refs as any).minimapSyncInProgress = false;
          }
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
  }, [feedStage, plotLayout]);
  
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
    // new-index.html approach: simple scheduleFlush that just uses RAF
    if (pendingUpdateRef.current === null) {
      // Use requestAnimationFrame for smooth 60fps rendering
      // Unlike the previous complex scheduling, just use RAF consistently
      pendingUpdateRef.current = requestAnimationFrame(() => {
        pendingUpdateRef.current = null;
        processBatchedSamples();
      });
    }
  }, [onDataClockUpdate, processBatchedSamples, config]);

  // Control functions
  const setLiveMode = useCallback((live: boolean) => {
    isLiveRef.current = live;
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
    isLiveRef.current = true;
    userInteractedRef.current = false;
    
    const lastTime = lastDataTimeRef.current;
    if (lastTime > 0) {
      const windowMs = 5 * 60 * 1000;
      const newRange = new NumberRange(lastTime - windowMs, lastTime + windowMs * 0.05);
      
      const tickXAxis = chartRefs.current.tickSurface?.xAxes.get(0);
      const ohlcXAxis = chartRefs.current.ohlcSurface?.xAxes.get(0);
      
      if (tickXAxis) tickXAxis.visibleRange = newRange;
      if (ohlcXAxis) ohlcXAxis.visibleRange = newRange;
    }
  }, []);

  // Set time window - sets X-axis visible range to last N minutes from current data clock
  const setTimeWindow = useCallback((minutes: number, dataClockMs: number) => {
    if (minutes <= 0) {
      // Zero or negative means show all data (zoom extents)
      zoomExtents();
      return;
    }

    const windowMs = minutes * 60 * 1000;
    const endMs = dataClockMs / 1000; // Convert to seconds for SciChart DateTimeNumericAxis
    const startMs = endMs - (windowMs / 1000);
    const padding = (windowMs / 1000) * 0.02; // 2% padding on right edge
    const newRange = new NumberRange(startMs, endMs + padding);

    console.log(`[setTimeWindow] Setting ${minutes} min window: ${new Date(startMs * 1000).toISOString()} - ${new Date(endMs * 1000).toISOString()}`);

    // Pause auto-scroll when user explicitly selects a time window
    isLiveRef.current = false;
    userInteractedRef.current = true;

    // Update all dynamic pane surfaces
    for (const [paneId, paneSurface] of chartRefs.current.paneSurfaces) {
      try {
        if (paneSurface.xAxis) {
          paneSurface.xAxis.visibleRange = newRange;
          paneSurface.surface.invalidateElement();
        }
      } catch (e) {
        console.warn(`[setTimeWindow] Failed to update pane ${paneId}:`, e);
      }
    }

    // Also update legacy surfaces if they exist
    const tickXAxis = chartRefs.current.tickSurface?.xAxes.get(0);
    const ohlcXAxis = chartRefs.current.ohlcSurface?.xAxes.get(0);
    
    if (tickXAxis) {
      tickXAxis.visibleRange = newRange;
      chartRefs.current.tickSurface?.invalidateElement();
    }
    if (ohlcXAxis) {
      ohlcXAxis.visibleRange = newRange;
      chartRefs.current.ohlcSurface?.invalidateElement();
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
