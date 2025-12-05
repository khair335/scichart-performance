import { useEffect, useRef, useState, useCallback } from 'react';
import {
  SciChartSurface,
  NumericAxis,
  DateTimeNumericAxis,
  FastLineRenderableSeries,
  FastCandlestickRenderableSeries,
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
} from 'scichart';
import type { Sample } from '@/lib/wsfeed-client';
import { defaultChartConfig } from '@/types/chart';
import { parseSeriesType, isTickChartSeries, isOhlcChartSeries } from '@/lib/series-namespace';

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
}

// Unified DataSeries Store Entry
interface DataSeriesEntry {
  dataSeries: XyDataSeries | OhlcDataSeries;
  renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries;
  chartTarget: 'tick' | 'ohlc'; // Which chart surface this series belongs to
  seriesType: 'tick' | 'ohlc-bar' | 'tick-indicator' | 'bar-indicator' | 'strategy-marker' | 'strategy-signal' | 'strategy-pnl' | 'other';
}

interface ChartRefs {
  tickSurface: SciChartSurface | null;
  ohlcSurface: SciChartSurface | null;
  tickWasm: TSciChart | null;
  ohlcWasm: TSciChart | null;
  // Unified DataSeries Store: series_id → DataSeriesEntry
  // This replaces separate Maps and allows dynamic discovery
  dataSeriesStore: Map<string, DataSeriesEntry>;
  verticalGroup: SciChartVerticalGroup | null;
  overview: SciChartOverview | null;
}

// Helper function to get Y range from any data series type
function getDataSeriesYRange(dataSeries: XyDataSeries | OhlcDataSeries, xMin?: number, xMax?: number): { min: number; max: number } | null {
  try {
    if (dataSeries.count() === 0) return null;
    
    let yMin = Infinity;
    let yMax = -Infinity;
    const count = dataSeries.count();
    
    // Check if it's an OHLC series (has high/low values)
    if ('getNativeHighValues' in dataSeries) {
      const ohlcDs = dataSeries as OhlcDataSeries;
      const xValues = ohlcDs.getNativeXValues();
      const highValues = ohlcDs.getNativeHighValues();
      const lowValues = ohlcDs.getNativeLowValues();
      
      for (let i = 0; i < count; i++) {
        const x = xValues.get(i);
        // Skip if outside X range (if specified)
        if (xMin !== undefined && xMax !== undefined) {
          if (x < xMin || x > xMax) continue;
        }
        const high = highValues.get(i);
        const low = lowValues.get(i);
        if (isFinite(high) && isFinite(low)) {
          yMin = Math.min(yMin, low);
          yMax = Math.max(yMax, high);
        }
      }
    } else {
      // XyDataSeries - use getNativeXValues and getNativeYValues
      const xyDs = dataSeries as XyDataSeries;
      const xValues = xyDs.getNativeXValues();
      const yValues = xyDs.getNativeYValues();
      
      for (let i = 0; i < count; i++) {
        const x = xValues.get(i);
        // Skip if outside X range (if specified)
        if (xMin !== undefined && xMax !== undefined) {
          if (x < xMin || x > xMax) continue;
        }
        const y = yValues.get(i);
        if (isFinite(y)) {
          yMin = Math.min(yMin, y);
          yMax = Math.max(yMax, y);
        }
      }
    }
    
    if (isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
      return { min: yMin, max: yMax };
    }
    
    return null;
  } catch (e) {
    return null;
  }
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
}: MultiPaneChartProps) {
  // Default UI config if not provided
  const defaultUIConfig: UIConfig = {
    data: {
      buffers: {
        pointsPerSeries: 1_000_000, // Default preallocation for ALL series (1M points)
        maxPointsTotal: 10_000_000, // Global cap across all series (10M points)
      },
    },
    performance: {
      targetFPS: 60,
      batchSize: 500,
      downsampleRatio: 2,
      maxAutoTicks: 8,
    },
    chart: {
      separateXAxes: true,
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
  
  // Helper to get preallocation capacity for any series
  const getSeriesCapacity = (): number => {
    return config.data?.buffers.pointsPerSeries ?? 1_000_000;
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
  
  // Helper to create a series on-demand if it doesn't exist (fallback for when registry preallocation hasn't run yet)
  const ensureSeriesExists = (seriesId: string): DataSeriesEntry | null => {
    const refs = chartRefs.current;
    
    // Check if already exists
    if (refs.dataSeriesStore.has(seriesId)) {
      return refs.dataSeriesStore.get(seriesId)!;
    }
    
    // Can't create if charts aren't ready
    if (!refs.tickSurface || !refs.ohlcSurface || !refs.tickWasm || !refs.ohlcWasm) {
      return null;
    }
    
    const seriesInfo = parseSeriesType(seriesId);
    
    // Only create series that should be plotted on charts
    if (seriesInfo.chartTarget === 'none') {
      return null;
    }
    
    try {
      const capacity = getSeriesCapacity();
      
      // Determine which WASM context and surface to use
      const wasm = seriesInfo.chartTarget === 'tick' ? refs.tickWasm : refs.ohlcWasm;
      const surface = seriesInfo.chartTarget === 'tick' ? refs.tickSurface : refs.ohlcSurface;
      
      if (!wasm || !surface) return null;
      
      // Create DataSeries with preallocated circular buffer
      let dataSeries: XyDataSeries | OhlcDataSeries;
      let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries;
      
      if (seriesInfo.type === 'ohlc-bar') {
        // OHLC bar series
        dataSeries = new OhlcDataSeries(wasm, {
          dataSeriesName: seriesId,
          fifoCapacity: capacity,
          capacity: capacity,
          containsNaN: false,
          dataIsSortedInX: true,
          dataEvenlySpacedInX: false,
        });
        
        renderableSeries = new FastCandlestickRenderableSeries(wasm, {
          dataSeries: dataSeries as OhlcDataSeries,
          strokeUp: '#26a69a',
          brushUp: '#26a69a88',
          strokeDown: '#ef5350',
          brushDown: '#ef535088',
          strokeThickness: 1,
        });
      } else {
        // All other series (tick, indicators, strategy) use XyDataSeries
        dataSeries = new XyDataSeries(wasm, {
          dataSeriesName: seriesId,
          fifoCapacity: capacity,
          capacity: capacity,
          containsNaN: false,
          dataIsSortedInX: true,
          dataEvenlySpacedInX: false,
        });
        
        // Determine stroke color based on type
        let stroke = '#50C7E0'; // Default tick color
        if (seriesInfo.isIndicator) {
          stroke = '#F48420'; // Orange for indicators
        } else if (seriesInfo.type === 'strategy-pnl') {
          stroke = '#4CAF50'; // Green for PnL
        } else if (seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') {
          stroke = '#FF9800'; // Orange for markers/signals
        }
        
        renderableSeries = new FastLineRenderableSeries(wasm, {
          dataSeries: dataSeries as XyDataSeries,
          stroke: stroke,
          strokeThickness: 1,
          pointMarker: undefined,
          resamplingMode: seriesInfo.type === 'tick' ? EResamplingMode.None : EResamplingMode.Auto,
        });
      }
      
      // Add to store
      const entry: DataSeriesEntry = {
        dataSeries,
        renderableSeries,
        chartTarget: seriesInfo.chartTarget,
        seriesType: seriesInfo.type,
      };
      refs.dataSeriesStore.set(seriesId, entry);
      
      // Add to appropriate chart surface
      surface.renderableSeries.add(renderableSeries);
      
      // Set initial visibility based on visibleSeries prop
      if (visibleSeries) {
        renderableSeries.isVisible = visibleSeries.has(seriesId);
      }
      
      console.log(`[MultiPaneChart] Created DataSeries on-demand for ${seriesId} (${seriesInfo.type}) on ${seriesInfo.chartTarget} chart with capacity ${capacity}, resamplingMode: ${seriesInfo.type === 'tick' ? 'None' : 'Auto'}`);
      
      // Invalidate surfaces to ensure new series are rendered
      refs.tickSurface.invalidateElement();
      refs.ohlcSurface.invalidateElement();
      
      return entry;
    } catch (e) {
      console.warn(`[MultiPaneChart] Failed to create DataSeries on-demand for ${seriesId}:`, e);
      return null;
    }
  };
  const chartRefs = useRef<ChartRefs>({
    tickSurface: null,
    ohlcSurface: null,
    tickWasm: null,
    ohlcWasm: null,
    // Unified DataSeries Store: series_id → DataSeriesEntry
    // All series (tick, OHLC, indicators) are stored here
    dataSeriesStore: new Map<string, DataSeriesEntry>(),
    verticalGroup: null,
    overview: null,
  });

  const [isReady, setIsReady] = useState(false);
  const fpsCounter = useRef({ frameCount: 0, lastTime: performance.now() });
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
  
  // Balanced downsampling: 2:1 ratio gives smooth curves while maintaining good FPS
  // 2:1 means render every 2nd point = 50% of points = still very smooth for sine waves
  // For 40 ticks/sec: 40 ÷ 2 = 20 rendered/sec × 60 sec = 1200 points/cycle = perfectly smooth!
  const BASE_DOWNSAMPLE_RATIO = 2;
  const lastDownsampleIndexRef = useRef<Map<string, number>>(new Map());
  
  // Reusable buffers for better performance - reuse instead of allocating new arrays
  const tickXBufferRef = useRef<Float64Array>(new Float64Array(10000));
  const tickYBufferRef = useRef<Float64Array>(new Float64Array(10000));
  const ohlcXBufferRef = useRef<Float64Array>(new Float64Array(1000));
  const ohlcOBufferRef = useRef<Float64Array>(new Float64Array(1000));
  const ohlcHBufferRef = useRef<Float64Array>(new Float64Array(1000));
  const ohlcLBufferRef = useRef<Float64Array>(new Float64Array(1000));
  const ohlcCBufferRef = useRef<Float64Array>(new Float64Array(1000));

  // Theme configuration - use 'Dark' as base and override with custom colors
  const chartTheme = {
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

  // Initialize charts
  useEffect(() => {
    let isMounted = true;

    const initCharts = async () => {
      try {
        console.log('[MultiPaneChart] Starting initialization...');
        
        // Check if containers exist and have dimensions
        const tickContainer = document.getElementById(tickContainerId);
        const ohlcContainer = document.getElementById(ohlcContainerId);
        
        if (!tickContainer) {
          console.error(`[MultiPaneChart] Container not found: ${tickContainerId}`);
          return;
        }
        if (!ohlcContainer) {
          console.error(`[MultiPaneChart] Container not found: ${ohlcContainerId}`);
          return;
        }

        // Ensure containers have dimensions
        const tickRect = tickContainer.getBoundingClientRect();
        const ohlcRect = ohlcContainer.getBoundingClientRect();
        
        if (tickRect.width === 0 || tickRect.height === 0) {
          console.warn(`[MultiPaneChart] Tick container has no dimensions, waiting...`);
          // Wait a bit for layout
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        if (ohlcRect.width === 0 || ohlcRect.height === 0) {
          console.warn(`[MultiPaneChart] OHLC container has no dimensions, waiting...`);
          // Wait a bit for layout
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        
        console.log('[MultiPaneChart] Loading WebAssembly from CDN...');
        SciChartSurface.useWasmFromCDN();

        // Disable DPI scaling for better performance on Retina/High-DPI displays
        // This prevents 4x pixel rendering which significantly improves FPS
        DpiHelper.IsDpiScaleEnabled = false;
        
        // Enable performance optimizations globally (large performance boost)
        SciChartDefaults.useNativeText = true; // Use native WebGL text for better performance
        SciChartDefaults.useSharedCache = true; // Share label cache across charts
        
        // Wait for WASM to be fully loaded and initialized
        // This ensures fonts and other systems are ready
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Also wait for a couple of animation frames to ensure everything is ready
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => requestAnimationFrame(resolve));

        console.log('[MultiPaneChart] Creating tick surface...');
        // Create tick/line surface with performance optimizations
        const tickResult = await SciChartSurface.create(tickContainerId, { 
          theme: chartTheme,
        });
        if (!isMounted) {
          tickResult.sciChartSurface.delete();
          return;
        }

        const { sciChartSurface: tickSurface, wasmContext: tickWasm } = tickResult;

        // Don't suspend updates initially - let the surface render once to initialize fonts
        // We'll suspend later when adding series

        // Configure tick axes - each pane has its own X-axis
        const tickXAxis = new DateTimeNumericAxis(tickWasm, {
          autoRange: EAutoRange.Once,
          drawMajorGridLines: false, // Disable gridlines for better FPS
          drawMinorGridLines: false,
          isVisible: true, // Each pane has its own visible X-axis
          useNativeText: true,
          useSharedCache: true,
          maxAutoTicks: config.performance.maxAutoTicks,
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
        console.log('[MultiPaneChart] Creating OHLC surface...');
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
        const ohlcXAxis = new DateTimeNumericAxis(ohlcWasm, {
          autoRange: EAutoRange.Once,
          drawMajorGridLines: false, // Disable gridlines for better FPS
          drawMinorGridLines: false,
          isVisible: true, // Each pane has its own visible X-axis
          useNativeText: true, // Use native text for better performance
          useSharedCache: true, // Share label cache
          maxAutoTicks: config.performance.maxAutoTicks, // Allow more ticks for adaptive zoom-based labels
          // Don't set majorDelta/minorDelta - let SciChart adapt based on zoom level!
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
          surface.chartModifiers.add(
            new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection }),
            new RubberBandXyZoomModifier({ isAnimated: false }), // Box zoom without animation for performance
            // Removed: ZoomPanModifier, ZoomExtentsModifier, XAxisDragModifier, YAxisDragModifier for FPS
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

        // FPS and GPU tracking
        const updateFps = () => {
          fpsCounter.current.frameCount++;
          const now = performance.now();
          const elapsed = now - fpsCounter.current.lastTime;
          if (elapsed >= 1000) {
            const fps = Math.round((fpsCounter.current.frameCount * 1000) / elapsed);
            fpsCounter.current.frameCount = 0;
            fpsCounter.current.lastTime = now;
            onFpsUpdate?.(fps);
            
            // Get GPU metrics from SciChart's WebGL rendering context
            // Estimate draw calls from renderableSeries count (each series = multiple draw calls)
            const tickSeriesCount = tickSurface.renderableSeries.size();
            const ohlcSeriesCount = ohlcSurface.renderableSeries.size();
            const estimatedDrawCalls = (tickSeriesCount + ohlcSeriesCount) * 2; // ~2 calls per series
            onGpuUpdate?.(estimatedDrawCalls);
          }
        };
        tickSurface.rendered.subscribe(updateFps);

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
        };

        // Note: Axis titles are intentionally omitted during initialization
        // to avoid font measurement errors. Titles can be added later once
        // the chart is fully rendered and fonts are initialized.
        // To add titles later, use: tickYAxis.axisTitle = 'Price';

        setIsReady(true);
        onReadyChange?.(true);
        console.log('[MultiPaneChart] Initialization complete!');

      } catch (error) {
        console.error('[MultiPaneChart] Initialization error:', error);
        console.error('[MultiPaneChart] Error details:', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined,
        });
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
      chartRefs.current.overview?.delete();
    };
  }, [tickContainerId, ohlcContainerId]);

  // Handle overview/minimap creation/destruction when toggled
  // IMPORTANT: We use a separate useEffect for hide/show that doesn't trigger cleanup
  useEffect(() => {
    const refs = chartRefs.current;
    if (!refs.tickSurface || !isReady) return;

    let isCancelled = false;

    const handleOverview = async () => {
      // Hide/show overview instead of creating/deleting to avoid DataSeries deletion issues
      // SciChartOverview shares DataSeries with the main chart, so deleting it breaks the main chart
      if (!overviewContainerId) {
        // Hide the overview container but keep the overview object alive
        if (refs.overview && overviewContainerIdRef.current) {
          const overviewContainer = document.getElementById(overviewContainerIdRef.current);
          if (overviewContainer) {
            overviewContainer.style.display = 'none';
            // Note: We can't suspend SciChartOverview's internal surface directly
            // The overview will continue to sync, but hiding the container prevents rendering
            // This is acceptable - the sync won't cause errors if the container is hidden
            console.log('[MultiPaneChart] Overview hidden (not deleted to preserve DataSeries)');
          }
        }
        return;
      }

      // Create or show overview
      if (overviewContainerId) {
        try {
          // Wait a bit to ensure the container is rendered
          await new Promise(resolve => setTimeout(resolve, 100));
          
          if (isCancelled) return;
          
          const overviewContainer = document.getElementById(overviewContainerId);
          if (overviewContainer && refs.tickSurface) {
            // If overview already exists, just show it
            if (refs.overview) {
              overviewContainer.style.display = '';
              console.log('[MultiPaneChart] Overview shown (reused existing)');
            } else {
              // Create new overview
              overviewContainer.style.display = '';
              
              const overview = await SciChartOverview.create(refs.tickSurface, overviewContainerId, {
                theme: chartTheme,
              });
              
              if (!isCancelled) {
                refs.overview = overview;
                overviewContainerIdRef.current = overviewContainerId; // Store the ID used
                console.log('[MultiPaneChart] Overview created successfully');
              } else {
                // Cleanup if cancelled during creation
                try {
                  overview.delete();
                } catch (e) {
                  // Ignore cleanup errors
                }
              }
            }
          } else if (!overviewContainer) {
            console.warn(`[MultiPaneChart] Overview container not found: ${overviewContainerId}`);
          }
        } catch (e) {
          console.warn('[MultiPaneChart] Failed to create/show overview:', e);
        }
      }
    };

    handleOverview();

    // NO CLEANUP HERE - we only delete on component unmount (see main useEffect cleanup)
    // This prevents the overview from being deleted when overviewContainerId changes
  }, [overviewContainerId, isReady]);

  // Separate cleanup effect that only runs on component unmount
  useEffect(() => {
    return () => {
      const refs = chartRefs.current;
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
    if (!refs.tickSurface || !refs.ohlcSurface || !refs.tickWasm || !refs.ohlcWasm) return;
    if (!registry || registry.length === 0) return;
    if (!isReady) return; // Wait for charts to be initialized
    
    const capacity = getSeriesCapacity();
    
    registry.forEach(regEntry => {
      const seriesId = regEntry.id;
      
      // Skip if already in store (already preallocated)
      if (refs.dataSeriesStore.has(seriesId)) return;
      
      const seriesInfo = parseSeriesType(seriesId);
      
      // Only preallocate series that should be plotted on charts
      if (seriesInfo.chartTarget === 'none') return;
      
      try {
        // Determine which WASM context and surface to use
        const wasm = seriesInfo.chartTarget === 'tick' ? refs.tickWasm : refs.ohlcWasm;
        const surface = seriesInfo.chartTarget === 'tick' ? refs.tickSurface : refs.ohlcSurface;
        
        if (!wasm || !surface) return;
        
        // Create DataSeries with preallocated circular buffer (same logic as ensureSeriesExists)
        let dataSeries: XyDataSeries | OhlcDataSeries;
        let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries;
        
        if (seriesInfo.type === 'ohlc-bar') {
          // OHLC bar series
          dataSeries = new OhlcDataSeries(wasm, {
            dataSeriesName: seriesId,
            fifoCapacity: capacity,
            capacity: capacity,
            containsNaN: false,
            dataIsSortedInX: true,
            dataEvenlySpacedInX: false,
          });
          
          renderableSeries = new FastCandlestickRenderableSeries(wasm, {
            dataSeries: dataSeries as OhlcDataSeries,
            strokeUp: '#26a69a',
            brushUp: '#26a69a88',
            strokeDown: '#ef5350',
            brushDown: '#ef535088',
            strokeThickness: 1,
          });
        } else {
          // All other series (tick, indicators, strategy) use XyDataSeries
          dataSeries = new XyDataSeries(wasm, {
            dataSeriesName: seriesId,
            fifoCapacity: capacity,
            capacity: capacity,
            containsNaN: false,
            dataIsSortedInX: true,
            dataEvenlySpacedInX: false,
          });
          
          // Determine stroke color based on type
          let stroke = '#50C7E0'; // Default tick color
          if (seriesInfo.isIndicator) {
            stroke = '#F48420'; // Orange for indicators
          } else if (seriesInfo.type === 'strategy-pnl') {
            stroke = '#4CAF50'; // Green for PnL
          } else if (seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') {
            stroke = '#FF9800'; // Orange for markers/signals
          }
          
          renderableSeries = new FastLineRenderableSeries(wasm, {
            dataSeries: dataSeries as XyDataSeries,
            stroke: stroke,
            strokeThickness: 1,
            pointMarker: undefined,
            resamplingMode: seriesInfo.type === 'tick' ? EResamplingMode.None : EResamplingMode.Auto,
          });
        }
        
        // Add to store
        refs.dataSeriesStore.set(seriesId, {
          dataSeries,
          renderableSeries,
          chartTarget: seriesInfo.chartTarget,
          seriesType: seriesInfo.type,
        });
        
        // Add to appropriate chart surface
        surface.renderableSeries.add(renderableSeries);
        
        // Set initial visibility based on visibleSeries prop
        if (visibleSeries) {
          renderableSeries.isVisible = visibleSeries.has(seriesId);
        }
        
        console.log(`[MultiPaneChart] Preallocated DataSeries for ${seriesId} (${seriesInfo.type}) on ${seriesInfo.chartTarget} chart with capacity ${capacity}, resamplingMode: ${seriesInfo.type === 'tick' ? 'None' : 'Auto'}`);
      } catch (e) {
        console.warn(`[MultiPaneChart] Failed to preallocate DataSeries for ${seriesId}:`, e);
      }
    });
    
    // Invalidate surfaces to ensure new series are rendered
    refs.tickSurface.invalidateElement();
    refs.ohlcSurface.invalidateElement();
  }, [registry, visibleSeries, isReady]);
  
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
    refs.tickSurface.suspendUpdates();
    refs.ohlcSurface.suspendUpdates();
    
    try {
      refs.dataSeriesStore.forEach((entry, seriesId) => {
        if (entry.renderableSeries) {
          entry.renderableSeries.isVisible = visibleSeries ? visibleSeries.has(seriesId) : true;
          
          // Set resampling mode for tick series (None for pure sine waves)
          if (entry.seriesType === 'tick' && entry.renderableSeries instanceof FastLineRenderableSeries) {
            entry.renderableSeries.resamplingMode = EResamplingMode.None;
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
      refs.tickSurface.resumeUpdates();
      refs.ohlcSurface.resumeUpdates();
      
      // Invalidate to show visibility changes, but Y-axis range is already preserved
      requestAnimationFrame(() => {
        refs.tickSurface?.invalidateElement();
        refs.ohlcSurface?.invalidateElement();
      });
    }
  }, [visibleSeries]);

  // Process accumulated samples and update chart
  const processBatchedSamples = useCallback(() => {
    const refs = chartRefs.current;
    if (!refs.tickSurface || !refs.ohlcSurface) return;
    
    // Don't process if overview is being cleaned up (prevents race conditions)
    if (isCleaningUpOverviewRef.current) {
      return;
    }
    
    // Skip chart updates during range restoration to prevent shaking
    // But still update time tracking for clock display
    const skipChartUpdates = isRestoringRangeRef.current;
    
    const allSamples = sampleBufferRef.current;
    if (allSamples.length === 0) return;
    
    // Batch sizing: allow reasonably large batches for smooth auto-scroll without overloading WASM.
    // Batch size from UI config
    const MAX_BATCH_SIZE = config.performance.batchSize;
    const samples = allSamples.length > MAX_BATCH_SIZE
      ? allSamples.slice(0, MAX_BATCH_SIZE)
      : allSamples;
    
    // Keep remaining samples for next frame
    sampleBufferRef.current = allSamples.length > MAX_BATCH_SIZE
      ? allSamples.slice(MAX_BATCH_SIZE)
      : [];
    pendingUpdateRef.current = null;

    // Unified buffer map: series_id → { x: [], y: [] } or { x: [], o: [], h: [], l: [], c: [] }
    // This replaces separate tickX/tickY/ohlcX/etc arrays
    const seriesBuffers: Map<string, { 
      x: number[]; 
      y?: number[]; 
      o?: number[]; 
      h?: number[]; 
      l?: number[]; 
      c?: number[]; 
    }> = new Map();

    let latestTime = lastDataTimeRef.current;

    // Process all samples in batch (optimized loop)
    // Now using unified store - all series go through the same code path
    const samplesLength = samples.length;
    for (let i = 0; i < samplesLength; i++) {
      const sample = samples[i];
      const { series_id, t_ms, payload } = sample;
      
      if (t_ms > latestTime) {
        latestTime = t_ms;
      }

      // Get series entry from unified store (preallocated by registry listener)
      // If not found, create it on-demand as a fallback
      let seriesEntry = refs.dataSeriesStore.get(series_id);
      if (!seriesEntry) {
        // Series not preallocated yet - create on-demand (fallback for when registry hasn't populated yet)
        seriesEntry = ensureSeriesExists(series_id);
        if (!seriesEntry) {
          // Still can't create - skip this sample
          continue;
        }
      }

      const seriesInfo = parseSeriesType(series_id);

      // OHLC bar data - special handling for OHLC format
      if (seriesInfo.type === 'ohlc-bar') {
        const o = payload.o as number;
        const h = payload.h as number;
        const l = payload.l as number;
        const c = payload.c as number;
        if (typeof o === 'number' && typeof h === 'number' && typeof l === 'number' && typeof c === 'number') {
          let buf = seriesBuffers.get(series_id);
          if (!buf) {
            buf = { x: [], o: [], h: [], l: [], c: [] };
            seriesBuffers.set(series_id, buf);
          }
          buf.x.push(t_ms);
          buf.o!.push(o);
          buf.h!.push(h);
          buf.l!.push(l);
          buf.c!.push(c);
        }
      } else {
        // All other series (tick, indicators, strategy) use XyDataSeries
        // Apply downsampling for tick and indicator data
        let count = lastDownsampleIndexRef.current.get(series_id) || 0;
        count++;
        lastDownsampleIndexRef.current.set(series_id, count);
        
        if (count >= BASE_DOWNSAMPLE_RATIO) {
          let value: number | null = null;
          
          // Extract value based on series type
          if (seriesInfo.type === 'tick') {
            value = payload.price as number;
          } else if (seriesInfo.isIndicator || seriesInfo.type === 'strategy-pnl') {
            value = payload.value as number;
          } else if (seriesInfo.type === 'strategy-marker' || seriesInfo.type === 'strategy-signal') {
            value = payload.price as number || payload.value as number;
          }
          
          if (typeof value === 'number') {
            let buf = seriesBuffers.get(series_id);
            if (!buf) {
              buf = { x: [], y: [] };
              seriesBuffers.set(series_id, buf);
            }
            buf.x.push(t_ms);
            buf.y!.push(value);
            lastDownsampleIndexRef.current.set(series_id, 0);
          }
        }
      }
    }

    lastDataTimeRef.current = latestTime;
    onDataClockUpdate?.(latestTime);

    // CRITICAL: During history/delta loading, DO NOT update X-axis range
    // This prevents unwanted scrolling during history loading
    // The X-axis will be set correctly when transitioning to live mode based on actual data
    // Only allow auto-scroll in live mode (checked in processBatchedSamples)

    // Only update charts if we have data to append (prevents unnecessary renders)
    // Check if any series buffers have data
    let hasData = false;
    for (const [seriesId, buf] of seriesBuffers) {
      if (buf.x.length > 0) {
        hasData = true;
        break;
      }
    }
    if (!hasData) {
      return; // No data to append, skip chart updates but time is already updated
    }

    // During range restoration: append data to DataSeries but skip chart rendering
    // This allows us to get actual data range while preventing visual updates that cause shaking
    const skipChartRendering = isRestoringRangeRef.current;
    
    // Batch updates with proper error handling to prevent WASM crashes
    let tickSuspended = false;
    let ohlcSuspended = false;
    
    try {
      // Only suspend if not already suspended and not skipping rendering
      // During restoration, we append data but don't render to prevent shaking
      if (!skipChartRendering) {
        try {
          if (refs.tickSurface) {
    refs.tickSurface.suspendUpdates();
            tickSuspended = true;
          }
        } catch (suspendError) {
          console.warn('[MultiPaneChart] Error suspending tick surface:', suspendError);
          // Continue anyway - surface might already be suspended
        }

        try {
          if (refs.ohlcSurface) {
    refs.ohlcSurface.suspendUpdates();
            ohlcSuspended = true;
          }
        } catch (suspendError) {
          console.warn('[MultiPaneChart] Error suspending ohlc surface:', suspendError);
          // Continue anyway - surface might already be suspended
        }
      }

      // Append data to all series using unified store
      // All series (tick, OHLC, indicators, strategy) go through the same code path
      for (const [seriesId, buf] of seriesBuffers) {
        const seriesEntry = refs.dataSeriesStore.get(seriesId);
        if (!seriesEntry) {
          // Series not in store - skip (shouldn't happen if registry preallocation is working)
          console.warn(`[MultiPaneChart] Series ${seriesId} not found in dataSeriesStore - skipping append`);
          continue;
        }

        try {
          if (seriesEntry.seriesType === 'ohlc-bar') {
            // OHLC bar data - use OhlcDataSeries.appendRange
            if (buf.x.length > 0 && buf.o && buf.h && buf.l && buf.c) {
              (seriesEntry.dataSeries as OhlcDataSeries).appendRange(
                Float64Array.from(buf.x),
                Float64Array.from(buf.o),
                Float64Array.from(buf.h),
                Float64Array.from(buf.l),
                Float64Array.from(buf.c)
              );
            }
          } else {
            // All other series (tick, indicators, strategy) use XyDataSeries.appendRange
            if (buf.x.length > 0 && buf.y) {
              (seriesEntry.dataSeries as XyDataSeries).appendRange(
                Float64Array.from(buf.x),
                Float64Array.from(buf.y)
              );
            }
          }
        } catch (error) {
          console.error(`[MultiPaneChart] Error appending data to ${seriesId}:`, error);
          // Continue with other series even if one fails
        }
      }
    } catch (error) {
      console.error('[MultiPaneChart] WASM memory error in data append:', error);
      // Critical error - likely WASM out of memory
      // Clear the buffer to prevent crash loop
      sampleBufferRef.current = [];
    } finally {
      // Always resume updates even if error occurred - with retry logic
      // CRITICAL: This must succeed or chart will stop rendering
      const resumeWithRetry = (surface: SciChartSurface | null, surfaceName: string, wasSuspended: boolean) => {
        if (!surface || !wasSuspended) return;
        
        let retries = 3;
        let lastError: any = null;
        
        while (retries > 0) {
          try {
            surface.resumeUpdates();
            // Success - chart will resume rendering
            if (retries < 3) {
              console.log(`[MultiPaneChart] Successfully resumed ${surfaceName} after retry`);
            }
            return;
          } catch (e) {
            lastError = e;
            retries--;
            if (retries > 0) {
              // Retry immediately (synchronous)
              continue;
            }
          }
        }
        
        // All retries failed - critical error
        console.error(`[MultiPaneChart] CRITICAL: Failed to resume ${surfaceName} after all retries!`, lastError);
        // Last resort: try to force invalidate to trigger render
        try {
          surface.invalidateElement();
          console.warn(`[MultiPaneChart] Attempted to force invalidate ${surfaceName} as fallback`);
        } catch (invalidateError) {
          console.error(`[MultiPaneChart] Failed to invalidate ${surfaceName}:`, invalidateError);
        }
      };

      // Only resume if we actually suspended (skip rendering during restoration)
      if (!skipChartRendering) {
        resumeWithRetry(refs.tickSurface, 'tickSurface', tickSuspended);
        resumeWithRetry(refs.ohlcSurface, 'ohlcSurface', ohlcSuspended);
      }
    }

    // Skip auto-scroll and Y-axis updates during restoration to prevent shaking
    if (skipChartRendering) {
      return; // Data is appended, but no chart updates during restoration
    }
    
    // CRITICAL: If Y-axis scaling was requested (e.g., on live transition), do it now after data is processed
    // This ensures data is available when we try to scale, fixing the blank chart issue
    if (triggerYAxisScalingOnNextBatchRef.current) {
      triggerYAxisScalingOnNextBatchRef.current = false;
      
      // Use a small delay to ensure rendering is complete
      setTimeout(() => {
        try {
          const refs = chartRefs.current;
          
          // Scale tick chart Y-axis
          if (refs.tickSurface) {
            const tickXAxis = refs.tickSurface.xAxes.get(0);
            const tickYAxis = refs.tickSurface.yAxes.get(0);
            if (tickXAxis && tickXAxis.visibleRange && tickYAxis) {
              const xRange = tickXAxis.visibleRange.max - tickXAxis.visibleRange.min;
              if (xRange >= 60 * 1000) {
                // CRITICAL: Use zoomExtentsY() which automatically filters to visible X-axis range
                // This ensures Y-axis scales only to data visible in the current X-axis window
                // NOT the full history range
                try {
                  refs.tickSurface.zoomExtentsY();
                  refs.tickSurface.invalidateElement();
                  console.log('[MultiPaneChart] Y-axis auto-scaled (tick) using zoomExtentsY from data processing loop');
                } catch (e) {
                  // Fallback: manual calculation if zoomExtentsY fails
                  // But we need to filter to visible X-range to avoid scaling to full history
                  console.warn('[MultiPaneChart] zoomExtentsY failed, trying manual calculation with X-range filter:', e);
                  let yMin = Infinity;
                  let yMax = -Infinity;
                  let hasYData = false;
                  const visibleXMin = tickXAxis.visibleRange.min;
                  const visibleXMax = tickXAxis.visibleRange.max;
                  
                  for (const [seriesId, entry] of refs.dataSeriesStore) {
                    if (entry.chartTarget === 'tick' && entry.dataSeries.count() > 0) {
                      // Get Y-range for data within visible X-axis range only
                      const yRange = getDataSeriesYRange(entry.dataSeries, visibleXMin, visibleXMax);
                      if (yRange && isFinite(yRange.min) && isFinite(yRange.max) && yRange.max > yRange.min) {
                        yMin = Math.min(yMin, yRange.min);
                        yMax = Math.max(yMax, yRange.max);
                        hasYData = true;
                      }
                    }
                  }
                  
                  if (hasYData && isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
                    // Add 10% padding
                    const padding = (yMax - yMin) * 0.1;
                    tickYAxis.visibleRange = new NumberRange(yMin - padding, yMax + padding);
                    refs.tickSurface.invalidateElement();
                    console.log(`[MultiPaneChart] Y-axis auto-scaled (tick) manually: ${yMin.toFixed(2)} to ${yMax.toFixed(2)} from data processing loop`);
                  } else {
                    console.warn('[MultiPaneChart] Manual Y-range calculation failed - no valid Y-data found');
                  }
                }
              }
            }
          }
          
          // Scale OHLC chart Y-axis
          if (refs.ohlcSurface) {
            const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
            const ohlcYAxis = refs.ohlcSurface.yAxes.get(0);
            if (ohlcXAxis && ohlcXAxis.visibleRange && ohlcYAxis) {
              const xRange = ohlcXAxis.visibleRange.max - ohlcXAxis.visibleRange.min;
              if (xRange >= 60 * 1000) {
                // CRITICAL: Use zoomExtentsY() which automatically filters to visible X-axis range
                // This ensures Y-axis scales only to data visible in the current X-axis window
                // NOT the full history range
                try {
                  refs.ohlcSurface.zoomExtentsY();
                  refs.ohlcSurface.invalidateElement();
                  console.log('[MultiPaneChart] Y-axis auto-scaled (ohlc) using zoomExtentsY from data processing loop');
                } catch (e) {
                  // Fallback: manual calculation if zoomExtentsY fails
                  // But we need to filter to visible X-range to avoid scaling to full history
                  console.warn('[MultiPaneChart] zoomExtentsY failed, trying manual calculation with X-range filter:', e);
                  let yMin = Infinity;
                  let yMax = -Infinity;
                  let hasYData = false;
                  const visibleXMin = ohlcXAxis.visibleRange.min;
                  const visibleXMax = ohlcXAxis.visibleRange.max;
                  
                  for (const [seriesId, entry] of refs.dataSeriesStore) {
                    if (entry.chartTarget === 'ohlc' && entry.dataSeries.count() > 0) {
                      // Get Y-range for data within visible X-axis range only
                      const yRange = getDataSeriesYRange(entry.dataSeries, visibleXMin, visibleXMax);
                      if (yRange && isFinite(yRange.min) && isFinite(yRange.max) && yRange.max > yRange.min) {
                        yMin = Math.min(yMin, yRange.min);
                        yMax = Math.max(yMax, yRange.max);
                        hasYData = true;
                      }
                    }
                  }
                  
                  if (hasYData && isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
                    // Add 10% padding
                    const padding = (yMax - yMin) * 0.1;
                    ohlcYAxis.visibleRange = new NumberRange(yMin - padding, yMax + padding);
                    refs.ohlcSurface.invalidateElement();
                    console.log(`[MultiPaneChart] Y-axis auto-scaled (ohlc) manually: ${yMin.toFixed(2)} to ${yMax.toFixed(2)} from data processing loop`);
                  } else {
                    console.warn('[MultiPaneChart] Manual Y-range calculation failed - no valid Y-data found');
                  }
                }
              }
            }
          }
        } catch (error) {
          console.warn('[MultiPaneChart] Error in Y-axis scaling from data processing loop:', error);
        }
      }, 50); // Small delay to ensure data is rendered
    }

    // Auto-scroll ONLY in live mode - disable during history/delta loading
    // This prevents fast scrolling and Y-axis jumps during history loading
    const now = performance.now();
    const Y_AXIS_UPDATE_INTERVAL_MS = 200; // Throttle Y-axis updates to max once per 200ms
    const X_SCROLL_THRESHOLD_MS = config.chart.autoScrollThreshold; // From UI config
    
    // Only auto-scroll if:
    // 1. We're in live mode (not history/delta)
    // 2. User hasn't interacted
    // 3. We have valid time data
    // 4. We're not currently restoring the range (prevents override)
    // NOTE: Continue auto-scrolling even when tab is hidden to keep X-axis range current
    // This prevents jumping/shaking when tab becomes visible
    const isInLiveStage = feedStageRef.current === 'live';
    const shouldAutoScroll = isLiveRef.current && isInLiveStage && !userInteractedRef.current && latestTime > 0 && !isRestoringRangeRef.current;
    
    if (shouldAutoScroll) {
      // Continue auto-scrolling even when tab is hidden - this keeps the X-axis range current
      // When tab becomes visible, the range is already at the latest position, so no jumping
      // CRITICAL: In live mode, always show the latest data with a small, focused window
      // Use a fixed 2-minute window to ensure latest data is always visible
      const windowMs = 2 * 60 * 1000; // 2 minutes - small window to focus on latest data
      const tickXAxis = refs.tickSurface.xAxes.get(0);
      const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
      
      // CRITICAL: Get actual data range from DataSeries, not just latestTime timestamp
      // The latestTime might be March but data might be in February
      // Find the latest data point across all series in the unified store
      // DO NOT initialize with latestTime - it might be a future timestamp
      let actualDataMax = 0; // Start with 0, only use actual data
      let hasActualData = false;
      
      // Iterate through all series in store to find the latest data point
      for (const [seriesId, entry] of refs.dataSeriesStore) {
        try {
          if (entry.dataSeries.count() > 0) {
            const xRange = entry.dataSeries.getXRange();
            if (xRange && isFinite(xRange.max) && xRange.max > 0) {
              if (!hasActualData || xRange.max > actualDataMax) {
                actualDataMax = xRange.max; // Use the latest data point found
                hasActualData = true;
              }
            }
          }
        } catch (e) {
          // Continue with other series if one fails
        }
      }
      
      // CRITICAL: Only use latestTime as fallback if we have NO actual data
      // This prevents showing future timestamps when actual data is older
      if (!hasActualData && latestTime > 0) {
        console.warn('[MultiPaneChart] No actual data in DataSeries, using latestTime as fallback:', {
          latestTime: new Date(latestTime).toISOString(),
        });
        actualDataMax = latestTime;
      } else if (hasActualData) {
        // Verify actualDataMax is not ahead of latestTime (shouldn't happen, but log if it does)
        if (actualDataMax > latestTime + 60 * 1000) { // More than 1 minute ahead
          console.warn('[MultiPaneChart] WARNING: actualDataMax is ahead of latestTime:', {
            actualDataMax: new Date(actualDataMax).toISOString(),
            latestTime: new Date(latestTime).toISOString(),
            diffMinutes: Math.round((actualDataMax - latestTime) / 1000 / 60),
          });
        }
      }
      
      // Show latest data: range ends at latest data point (or slightly ahead for padding)
      // This ensures the latest series line is always in the current view
      // CRITICAL: Only create range if we have valid actualDataMax
      if (actualDataMax <= 0) {
        console.warn('[MultiPaneChart] Cannot create X-axis range - no valid data');
        return; // Skip auto-scroll if no valid data
      }
      
      const padding = 10 * 1000; // 10 seconds padding after latest data
      const newRange = new NumberRange(actualDataMax - windowMs, actualDataMax + padding);
      
      // Log for debugging
      if (hasActualData && actualDataMax < latestTime - 60 * 1000) { // More than 1 minute behind
        console.log('[MultiPaneChart] Auto-scroll using actual data (older than latestTime):', {
          actualDataMax: new Date(actualDataMax).toISOString(),
          latestTime: new Date(latestTime).toISOString(),
          diffMinutes: Math.round((latestTime - actualDataMax) / 1000 / 60),
        });
      }
      
      // Update X-axis scroll - always update in live mode to keep data visible
      // When tab is hidden, force updates to keep X-axis current (bypass threshold)
      const isTabHidden = document.hidden;
      const overviewContainerVisible = refs.overview && overviewContainerIdRef.current 
        ? (document.getElementById(overviewContainerIdRef.current)?.style.display !== 'none')
        : false;
      
      if (tickXAxis) {
        if (!tickXAxis.visibleRange) {
          // No range set - set it immediately to show latest data
          try {
            tickXAxis.visibleRange = newRange;
            if (isTabHidden) {
              refs.tickSurface.invalidateElement(); // Force update when hidden
            }
          } catch (e) {
            console.warn('[MultiPaneChart] Error setting initial tickXAxis visibleRange:', e);
          }
        } else {
          // Range exists - check if we need to update it
          const currentMax = tickXAxis.visibleRange.max;
          const currentMin = tickXAxis.visibleRange.min;
          const diff = Math.abs(currentMax - newRange.max);
          
          // Always update if:
          // 1. Tab is hidden (force update to keep X-axis current in background)
          // 2. Actual data is outside current range (data is not visible)
          // 3. Or diff is significant (smooth scrolling threshold)
          // 4. Or current range is too wide (showing old history instead of recent data)
          const isDataOutsideRange = actualDataMax > currentMax || actualDataMax < currentMin;
          const isDataAhead = actualDataMax > currentMax; // Data is ahead of visible range
          const currentRangeWidth = currentMax - currentMin;
          const isRangeTooWide = currentRangeWidth > windowMs * 1.5; // If range is > 15 minutes, it's too wide
          
          // When hidden, always update if there's any difference (no threshold)
          // When visible, use threshold for smooth scrolling
          const shouldUpdate = isTabHidden 
            ? (diff > 0) // Any difference when hidden
            : (isDataOutsideRange || diff > X_SCROLL_THRESHOLD_MS || isRangeTooWide);
          
          if (shouldUpdate) {
            try {
              const oldMax = tickXAxis.visibleRange?.max;
              tickXAxis.visibleRange = newRange;
              
              // Log update reason for debugging
              if (isDataOutsideRange || isDataAhead) {
                console.log('[MultiPaneChart] Auto-scroll FORCED update - data outside range:', {
                  oldMax: oldMax ? new Date(oldMax).toISOString() : 'none',
                  newMax: new Date(newRange.max).toISOString(),
                  actualDataMax: new Date(actualDataMax).toISOString(),
                  isDataOutsideRange,
                  isDataAhead,
                  currentRange: `${new Date(currentMin).toISOString()} to ${new Date(currentMax).toISOString()}`,
                });
              }
              
              if (isTabHidden) {
                refs.tickSurface.invalidateElement(); // Force update when hidden
              } else {
                refs.tickSurface.invalidateElement(); // Always invalidate to ensure update
              }
            } catch (e) {
              // If overview is in invalid state or hidden, ignore the error silently
              if (!overviewContainerVisible && refs.overview) {
                // Overview is hidden but still trying to sync - this is expected, ignore
              } else {
                console.warn('[MultiPaneChart] Error updating tickXAxis visibleRange:', e);
              }
            }
          }
        }
      }
      
      if (ohlcXAxis) {
        if (!ohlcXAxis.visibleRange) {
          // No range set - set it immediately to show latest data
          try {
            ohlcXAxis.visibleRange = newRange;
            if (isTabHidden) {
              refs.ohlcSurface.invalidateElement(); // Force update when hidden
            }
          } catch (e) {
            console.warn('[MultiPaneChart] Error setting initial ohlcXAxis visibleRange:', e);
          }
        } else {
          // Range exists - check if we need to update it
          const currentMax = ohlcXAxis.visibleRange.max;
          const currentMin = ohlcXAxis.visibleRange.min;
          const diff = Math.abs(currentMax - newRange.max);
          
          // Always update if:
          // 1. Tab is hidden (force update to keep X-axis current in background)
          // 2. Actual data is outside current range (data is not visible) - CRITICAL: Always update if data is outside
          // 3. Or diff is significant (smooth scrolling threshold)
          // 4. Or current range is too wide (showing old history instead of recent data)
          // 5. Or latest data is significantly ahead of current range max (user zoomed out too much)
          const isDataOutsideRange = actualDataMax > currentMax || actualDataMax < currentMin;
          const currentRangeWidth = currentMax - currentMin;
          const isRangeTooWide = currentRangeWidth > windowMs * 1.5; // If range is > 3 minutes (2min * 1.5), it's too wide
          const isDataAhead = actualDataMax > currentMax + windowMs; // Latest data is more than window size ahead
          
          // CRITICAL: If data is outside range or significantly ahead, ALWAYS update regardless of threshold
          // This ensures latest data is always visible, even if user manually zoomed out
          // When hidden, always update if there's any difference (no threshold)
          // When visible, use threshold for smooth scrolling, BUT force update if data is outside range
          const shouldUpdate = isTabHidden 
            ? (diff > 0) // Any difference when hidden
            : (isDataOutsideRange || isDataAhead || diff > X_SCROLL_THRESHOLD_MS || isRangeTooWide);
          
          if (shouldUpdate) {
            try {
              const oldMax = ohlcXAxis.visibleRange?.max;
              ohlcXAxis.visibleRange = newRange;
              
              // Log update reason for debugging
              if (isDataOutsideRange || isDataAhead) {
                console.log('[MultiPaneChart] Auto-scroll FORCED update (OHLC) - data outside range:', {
                  oldMax: oldMax ? new Date(oldMax).toISOString() : 'none',
                  newMax: new Date(newRange.max).toISOString(),
                  actualDataMax: new Date(actualDataMax).toISOString(),
                  isDataOutsideRange,
                  isDataAhead,
                  currentRange: `${new Date(currentMin).toISOString()} to ${new Date(currentMax).toISOString()}`,
                });
              }
              
              if (isTabHidden) {
                refs.ohlcSurface.invalidateElement(); // Force update when hidden
              } else {
                refs.ohlcSurface.invalidateElement(); // Always invalidate to ensure update
              }
            } catch (e) {
              // If overview is in invalid state or hidden, ignore the error silently
              if (!overviewContainerVisible && refs.overview) {
                // Overview is hidden but still trying to sync - this is expected, ignore
              } else {
                console.warn('[MultiPaneChart] Error updating ohlcXAxis visibleRange:', e);
              }
            }
          }
        }
      }
      
      // Manually update Y-axis range when needed (since we use EAutoRange.Once)
      // This gives us control over when Y-axis updates, preventing constant jumping
      // Only update Y-axis if X-axis has reasonable range to prevent jumping
      // Skip Y-axis updates during range restoration to prevent shaking
      // CRITICAL: If lastYAxisUpdateRef is 0, it means we just transitioned to live - force update immediately
      const shouldUpdateYAxis = !isRestoringRangeRef.current && 
                                (lastYAxisUpdateRef.current === 0 || now - lastYAxisUpdateRef.current >= Y_AXIS_UPDATE_INTERVAL_MS);
      
      if (shouldUpdateYAxis) {
        const refs = chartRefs.current;
        
        // Update Y-axis by zooming to extents (only Y-axis, not X-axis)
        // This calculates the optimal Y range from visible data points
        // Only do this if we have a reasonable X-axis range (at least 2 minutes)
        // This prevents Y-axis jumping when X-axis is too narrow
        // Update Y-axis for tick chart if we have tick series
        const tickSeries = findSeriesByType('tick');
        if (refs.tickSurface && tickSeries && tickSeries.dataSeries.count() > 0) {
          try {
            const tickXAxis = refs.tickSurface.xAxes.get(0);
            if (tickXAxis && tickXAxis.visibleRange) {
              const xRange = tickXAxis.visibleRange.max - tickXAxis.visibleRange.min;
              // Only update Y-axis if X-axis has reasonable range (at least 2 minutes)
              // This prevents Y-axis jumping and ensures sine waves are visible
              if (xRange >= 2 * 60 * 1000) {
                refs.tickSurface.zoomExtentsY();
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
        
        // Update Y-axis for OHLC chart if we have OHLC series
        const ohlcSeries = findSeriesByType('ohlc-bar');
        if (refs.ohlcSurface && ohlcSeries && ohlcSeries.dataSeries.count() > 0) {
          try {
            const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
            if (ohlcXAxis && ohlcXAxis.visibleRange) {
              const xRange = ohlcXAxis.visibleRange.max - ohlcXAxis.visibleRange.min;
              // Only update Y-axis if X-axis has reasonable range (at least 2 minutes)
              if (xRange >= 2 * 60 * 1000) {
                refs.ohlcSurface.zoomExtentsY();
              }
            }
          } catch (e) {
            // Ignore errors
          }
        }
        
        lastYAxisUpdateRef.current = now;
      }
    } else {
      // If not in live mode or auto-scroll is disabled, ensure X-axis range is set if we have data
      // This ensures data is visible even when not auto-scrolling
      if (latestTime > 0) {
        const refs = chartRefs.current;
        const tickXAxis = refs.tickSurface?.xAxes.get(0);
        const ohlcXAxis = refs.ohlcSurface?.xAxes.get(0);
        
        // Set initial X-axis range if not set - use wider window for better visibility
        if (tickXAxis && !tickXAxis.visibleRange) {
          const windowMs = 10 * 60 * 1000; // 10 minutes for better sine wave visibility
          const initialRange = new NumberRange(latestTime - windowMs, latestTime + 30 * 1000);
          try {
            tickXAxis.visibleRange = initialRange;
          } catch (e) {
            // Ignore errors
          }
        }
        
        if (ohlcXAxis && !ohlcXAxis.visibleRange) {
          const windowMs = 10 * 60 * 1000; // 10 minutes for better visibility
          const initialRange = new NumberRange(latestTime - windowMs, latestTime + 30 * 1000);
          try {
            ohlcXAxis.visibleRange = initialRange;
          } catch (e) {
            // Ignore errors
          }
        }
      }
    }
    
    lastRenderTimeRef.current = performance.now();
  }, [onDataClockUpdate, visibleSeries, config, feedStage]);
  
  // Track feed stage changes and handle transitions
  useEffect(() => {
    const prevStage = feedStageRef.current;
    feedStageRef.current = feedStage;
    
    // When transitioning to live, immediately set X-axis range to show latest data
    // This ensures data is visible right away, not coming from left
    // CRITICAL: Force update even if range exists - we need to jump to latest data, not show all history
    if (feedStage === 'live' && prevStage !== 'live') {
      historyLoadedRef.current = true;
      
          // Get actual data range from DataSeries to show real data, not empty range
          // CRITICAL: Use actual data range, not just latest timestamp
          // The latestTime might be March but data might be in February
          const refs = chartRefs.current;
          
          if (refs.tickSurface && refs.ohlcSurface) {
            try {
              const tickXAxis = refs.tickSurface.xAxes.get(0);
              const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
              
              // CRITICAL: Wait for all data processing to complete before setting X-axis range
              // This ensures we get the actual latest data point, not stale data
              // Use a recursive function that checks if data processing is complete
              const setXAxisRangeWhenReady = (attempt = 0, maxAttempts = 30) => {
                // Check if there's still data being processed
                const hasPendingData = sampleBufferRef.current.length > 0;
                const hasScheduledUpdate = pendingUpdateRef.current !== null;
                
                // If there's pending data or a scheduled update, and we haven't exceeded max attempts, wait a bit more
                if ((hasPendingData || hasScheduledUpdate) && attempt < maxAttempts) {
                  setTimeout(() => setXAxisRangeWhenReady(attempt + 1, maxAttempts), 50);
                  return;
                }
                
                // Log if we had to wait
                if (attempt > 0) {
                  console.log(`[MultiPaneChart] Waited ${attempt * 50}ms for data processing to complete before setting X-axis range`);
                }
                
                // Now get the actual data range from DataSeries
                // Use requestAnimationFrame to ensure rendering is complete
                requestAnimationFrame(() => {
                  setTimeout(() => {
                try {
                  // Get actual data range from tick DataSeries
                  let dataMin = 0;
                  let dataMax = 0;
                  let hasData = false;
                  let totalDataPoints = 0;
                  
                  // Try to get actual data range from any series in the unified store
                  // Find the earliest and latest data points across all series
                  for (const [seriesId, entry] of refs.dataSeriesStore) {
                    const count = entry.dataSeries.count();
                    totalDataPoints += count;
                    if (count > 0) {
                      try {
                        const xRange = entry.dataSeries.getXRange();
                        if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
                          if (!hasData) {
                            dataMin = xRange.min;
                            dataMax = xRange.max;
                            hasData = true;
                          } else {
                            // Expand range to include all series
                            if (xRange.min < dataMin) dataMin = xRange.min;
                            if (xRange.max > dataMax) dataMax = xRange.max;
                          }
                        }
                      } catch (e) {
                        console.warn(`[MultiPaneChart] Error getting X range from ${seriesId}:`, e);
                      }
                    }
                  }
                  
                  // Determine the range to show based on actual data
                  let liveRange: NumberRange;
                  
                  if (hasData && dataMax > 0) {
                    // CRITICAL: In live mode, always show the latest data with a small, focused window
                    // Use a fixed 2-minute window to ensure latest data is always visible
                    // This ensures users can always see the live data, regardless of history size
                    const windowMs = 2 * 60 * 1000; // 2 minutes - small window to focus on latest data
                    
                    // Show latest data: range ends at latest data point (or slightly ahead for padding)
                    // This ensures the latest series line is always in the current view
                    const latestDataTime = dataMax;
                    const padding = 10 * 1000; // 10 seconds padding after latest data
                    liveRange = new NumberRange(latestDataTime - windowMs, latestDataTime + padding);
                    
                    console.log('[MultiPaneChart] Setting X-axis range based on ACTUAL data in DataSeries:', {
                      dataMin: new Date(dataMin).toISOString(),
                      dataMax: new Date(dataMax).toISOString(),
                      rangeMin: new Date(liveRange.min).toISOString(),
                      rangeMax: new Date(liveRange.max).toISOString(),
                      dataPointCount: totalDataPoints,
                      historySpanMinutes: Math.round((dataMax - dataMin) / 1000 / 60),
                      windowMinutes: Math.round(windowMs / 1000 / 60),
                      lastDataTimeRef: new Date(lastDataTimeRef.current).toISOString(),
                    });
                    
                    // Verify: if dataMax is much older than lastDataTimeRef, there's a mismatch
                    const timeDiff = lastDataTimeRef.current - dataMax;
                    if (timeDiff > 60 * 60 * 1000) { // More than 1 hour difference
                      console.warn(`[MultiPaneChart] WARNING: Data timestamp mismatch! DataSeries max (${new Date(dataMax).toISOString()}) is ${Math.round(timeDiff / 1000 / 60)} minutes behind lastDataTimeRef (${new Date(lastDataTimeRef.current).toISOString()})`);
                    }
                  } else {
                    // CRITICAL: If no data in DataSeries, wait for data to arrive
                    // DO NOT use lastDataTimeRef as it might be a future timestamp that doesn't match actual data
                    // Instead, wait a bit longer and retry, or skip setting range until data is available
                    console.warn('[MultiPaneChart] No data in DataSeries yet - waiting for data before setting X-axis range. Will retry...', {
                      totalDataPoints,
                      lastDataTimeRef: new Date(lastDataTimeRef.current).toISOString(),
                    });
                    
                    // Retry after a longer delay to allow data to be processed
                    setTimeout(() => {
                      try {
                        let retryDataMax = 0;
                        let retryHasData = false;
                        
                        for (const [seriesId, entry] of refs.dataSeriesStore) {
                          if (entry.dataSeries.count() > 0) {
                            try {
                              const xRange = entry.dataSeries.getXRange();
                              if (xRange && isFinite(xRange.max) && xRange.max > retryDataMax) {
                                retryDataMax = xRange.max;
                                retryHasData = true;
                              }
                            } catch (e) {
                              // Ignore
                            }
                          }
                        }
                        
                        if (retryHasData && retryDataMax > 0) {
                          // Use same small window for retry - always show latest data
                          const retryWindowMs = 2 * 60 * 1000; // 2 minutes - small window to focus on latest data
                          const retryPadding = 10 * 1000; // 10 seconds padding after latest data
                          const retryRange = new NumberRange(retryDataMax - retryWindowMs, retryDataMax + retryPadding);
                          if (tickXAxis && ohlcXAxis) {
                            tickXAxis.visibleRange = retryRange;
                            ohlcXAxis.visibleRange = retryRange;
                            refs.tickSurface.invalidateElement();
                            refs.ohlcSurface.invalidateElement();
                            console.log('[MultiPaneChart] Set X-axis range on retry based on actual data:', {
                              rangeMin: new Date(retryRange.min).toISOString(),
                              rangeMax: new Date(retryRange.max).toISOString(),
                              dataMax: new Date(retryDataMax).toISOString(),
                            });
                          }
                        } else {
                          console.warn('[MultiPaneChart] Still no data after retry - X-axis range not set');
                        }
                      } catch (e) {
                        console.warn('[MultiPaneChart] Error in retry X-axis range setting:', e);
                      }
                    }, 500); // Wait 500ms for data to be processed
                    
                    return; // Skip setting range for now
                  }
                  
                  // FORCE set range to show actual data - always update when entering live mode
                  if (tickXAxis && liveRange) {
                    tickXAxis.visibleRange = liveRange;
                    refs.tickSurface.invalidateElement();
                  }
                  if (ohlcXAxis && liveRange) {
                    ohlcXAxis.visibleRange = liveRange;
                    refs.ohlcSurface.invalidateElement();
                  }
                } catch (e) {
                  console.warn('[MultiPaneChart] Error in delayed X-axis range setting:', e);
                }
                  }, 100); // Small delay after requestAnimationFrame to ensure rendering is complete
                });
              };
              
              // Start the recursive wait-and-set process
              // This ensures we wait for all data processing to complete before setting X-axis range
              setXAxisRangeWhenReady();
          
          // CRITICAL: Force Y-axis auto-scaling when transitioning to live
          // This ensures the chart is properly scaled to show data, not zoomed in too much
          // When there's a lot of history data, we need multiple attempts to ensure Y-axis scales properly
          const forceYAxisScaling = (attempt = 1, maxAttempts = 5) => {
            try {
              // Force Y-axis zoom to extents for both charts to show all visible data
              // This is essential because Y-axis uses EAutoRange.Once and won't auto-scale
              let tickScaled = false;
              let ohlcScaled = false;
              
              if (refs.tickSurface) {
                const tickXAxis = refs.tickSurface.xAxes.get(0);
                const tickYAxis = refs.tickSurface.yAxes.get(0);
                if (tickXAxis && tickXAxis.visibleRange && tickYAxis) {
                  const xRange = tickXAxis.visibleRange.max - tickXAxis.visibleRange.min;
                  // Only zoom Y-axis if X-axis has reasonable range (at least 1 minute)
                  // This prevents errors if X-axis is not set yet
                  if (xRange >= 60 * 1000) {
                    // Check if we have visible renderable series with data
                    // For large history, data might exist but not be fully processed yet
                    // So we check if data exists first, then verify it's in range (less strict)
                    const visibleEntries = Array.from(refs.dataSeriesStore.values()).filter(entry => {
                      if (entry.chartTarget !== 'tick') return false;
                      if (!entry.renderableSeries) return false;
                      // Check visibility - but if no series are visible, still try to scale (data might be there)
                      // This handles the case where data exists but visibility hasn't been set yet
                      if (entry.dataSeries.count() === 0) return false;
                      
                      // If series is explicitly hidden, skip it
                      if (entry.renderableSeries.isVisible === false) return false;
                      
                      // For large history, data might exist but range check might fail due to timing
                      // So we're more lenient - if data exists and series is not explicitly hidden, include it
                      try {
                        const dataXRange = entry.dataSeries.getXRange();
                        if (dataXRange && isFinite(dataXRange.min) && isFinite(dataXRange.max)) {
                          // Check if data overlaps with visible X-axis range OR if data exists (less strict)
                          // This handles cases where data is still being processed
                          const overlaps = dataXRange.min <= tickXAxis.visibleRange.max && 
                                          dataXRange.max >= tickXAxis.visibleRange.min;
                          // If data exists and is close to the range, include it (within 1 hour)
                          const isClose = Math.abs(dataXRange.max - tickXAxis.visibleRange.max) < 60 * 60 * 1000;
                          return overlaps || isClose;
                        }
                      } catch (e) {
                        // If getXRange fails, but data exists, still try to use it
                        // This handles edge cases where data is being processed
                        return true; // Data exists, try to use it
                      }
                      return false;
                    });
                    
                    // If no visible entries found, try to find any entries with data (fallback)
                    // This handles the case where data exists but visibility check is too strict
                    const entriesWithData = visibleEntries.length === 0 
                      ? Array.from(refs.dataSeriesStore.values()).filter(entry => {
                          if (entry.chartTarget !== 'tick') return false;
                          if (entry.dataSeries.count() === 0) return false;
                          if (entry.renderableSeries?.isVisible === false) return false; // Still skip explicitly hidden
                          return true; // Data exists, try to use it
                        })
                      : visibleEntries;
                    
                    if (entriesWithData.length > 0) {
                      try {
                        // First, try manual calculation to ensure we have valid Y-range
                        // zoomExtentsY() might not work if data isn't fully rendered yet
                        let yMin = Infinity;
                        let yMax = -Infinity;
                        let hasYData = false;
                        
                        for (const entry of entriesWithData) {
                          const yRange = getDataSeriesYRange(entry.dataSeries);
                          if (yRange && isFinite(yRange.min) && isFinite(yRange.max) && yRange.max > yRange.min) {
                            yMin = Math.min(yMin, yRange.min);
                            yMax = Math.max(yMax, yRange.max);
                            hasYData = true;
                          }
                        }
                        
                        if (hasYData && isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
                          // Add 10% padding
                          const padding = (yMax - yMin) * 0.1;
                          const newYRange = new NumberRange(yMin - padding, yMax + padding);
                          
                          // Set Y-axis range manually (more reliable than zoomExtentsY for large history)
                          tickYAxis.visibleRange = newYRange;
                          refs.tickSurface.invalidateElement();
                          tickScaled = true;
                          console.log(`[MultiPaneChart] Y-axis auto-scaled (tick) using manual calculation: ${yMin.toFixed(2)} to ${yMax.toFixed(2)} (attempt ${attempt})`);
                        } else {
                          // Fallback: try zoomExtentsY if manual calculation didn't work
                          try {
                            refs.tickSurface.zoomExtentsY();
                            refs.tickSurface.invalidateElement();
                            tickScaled = true;
                            console.log(`[MultiPaneChart] Y-axis auto-scaled (tick) using zoomExtentsY fallback (attempt ${attempt})`);
                          } catch (zoomError) {
                            console.warn('[MultiPaneChart] Both manual calculation and zoomExtentsY failed for tick chart:', zoomError);
                          }
                        }
                      } catch (error) {
                        console.warn('[MultiPaneChart] Error in Y-axis scaling for tick chart:', error);
                      }
                    } else {
                      console.warn(`[MultiPaneChart] No tick data found (attempt ${attempt})`);
                    }
                  }
                }
              }
              
              if (refs.ohlcSurface) {
                const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
                const ohlcYAxis = refs.ohlcSurface.yAxes.get(0);
                if (ohlcXAxis && ohlcXAxis.visibleRange && ohlcYAxis) {
                  const xRange = ohlcXAxis.visibleRange.max - ohlcXAxis.visibleRange.min;
                    if (xRange >= 60 * 1000) {
                    // Check if we have visible renderable series with data
                    // For large history, data might exist but not be fully processed yet
                    // So we check if data exists first, then verify it's in range (less strict)
                    const visibleEntries = Array.from(refs.dataSeriesStore.values()).filter(entry => {
                      if (entry.chartTarget !== 'ohlc') return false;
                      if (!entry.renderableSeries) return false;
                      // Check visibility - but if no series are visible, still try to scale (data might be there)
                      // This handles the case where data exists but visibility hasn't been set yet
                      if (entry.dataSeries.count() === 0) return false;
                      
                      // If series is explicitly hidden, skip it
                      if (entry.renderableSeries.isVisible === false) return false;
                      
                      // For large history, data might exist but range check might fail due to timing
                      // So we're more lenient - if data exists and series is not explicitly hidden, include it
                      try {
                        const dataXRange = entry.dataSeries.getXRange();
                        if (dataXRange && isFinite(dataXRange.min) && isFinite(dataXRange.max)) {
                          // Check if data overlaps with visible X-axis range OR if data exists (less strict)
                          // This handles cases where data is still being processed
                          const overlaps = dataXRange.min <= ohlcXAxis.visibleRange.max && 
                                          dataXRange.max >= ohlcXAxis.visibleRange.min;
                          // If data exists and is close to the range, include it (within 1 hour)
                          const isClose = Math.abs(dataXRange.max - ohlcXAxis.visibleRange.max) < 60 * 60 * 1000;
                          return overlaps || isClose;
                        }
                      } catch (e) {
                        // If getXRange fails, but data exists, still try to use it
                        // This handles edge cases where data is being processed
                        return true; // Data exists, try to use it
                      }
                      return false;
                    });
                    
                    // If no visible entries found, try to find any entries with data (fallback)
                    // This handles the case where data exists but visibility check is too strict
                    const entriesWithData = visibleEntries.length === 0 
                      ? Array.from(refs.dataSeriesStore.values()).filter(entry => {
                          if (entry.chartTarget !== 'ohlc') return false;
                          if (entry.dataSeries.count() === 0) return false;
                          if (entry.renderableSeries?.isVisible === false) return false; // Still skip explicitly hidden
                          return true; // Data exists, try to use it
                        })
                      : visibleEntries;
                    
                    if (entriesWithData.length > 0) {
                      try {
                        // First, try manual calculation to ensure we have valid Y-range
                        // zoomExtentsY() might not work if data isn't fully rendered yet
                        let yMin = Infinity;
                        let yMax = -Infinity;
                        let hasYData = false;
                        
                        for (const entry of entriesWithData) {
                          const yRange = getDataSeriesYRange(entry.dataSeries);
                          if (yRange && isFinite(yRange.min) && isFinite(yRange.max) && yRange.max > yRange.min) {
                            yMin = Math.min(yMin, yRange.min);
                            yMax = Math.max(yMax, yRange.max);
                            hasYData = true;
                          }
                        }
                        
                        if (hasYData && isFinite(yMin) && isFinite(yMax) && yMax > yMin) {
                          // Add 10% padding
                          const padding = (yMax - yMin) * 0.1;
                          const newYRange = new NumberRange(yMin - padding, yMax + padding);
                          
                          // Set Y-axis range manually (more reliable than zoomExtentsY for large history)
                          ohlcYAxis.visibleRange = newYRange;
                          refs.ohlcSurface.invalidateElement();
                          ohlcScaled = true;
                          console.log(`[MultiPaneChart] Y-axis auto-scaled (ohlc) using manual calculation: ${yMin.toFixed(2)} to ${yMax.toFixed(2)} (attempt ${attempt})`);
                        } else {
                          // Fallback: try zoomExtentsY if manual calculation didn't work
                          try {
                            refs.ohlcSurface.zoomExtentsY();
                            refs.ohlcSurface.invalidateElement();
                            ohlcScaled = true;
                            console.log(`[MultiPaneChart] Y-axis auto-scaled (ohlc) using zoomExtentsY fallback (attempt ${attempt})`);
                          } catch (zoomError) {
                            console.warn('[MultiPaneChart] Both manual calculation and zoomExtentsY failed for OHLC chart:', zoomError);
                          }
                        }
                      } catch (error) {
                        console.warn('[MultiPaneChart] Error in Y-axis scaling for OHLC chart:', error);
                      }
                    } else {
                      console.warn(`[MultiPaneChart] No OHLC data found (attempt ${attempt})`);
                    }
                  }
                }
              }
              
              // If scaling didn't work and we haven't exceeded max attempts, try again
              // This is especially important when there's a lot of history data that's still processing
              if (attempt < maxAttempts && (!tickScaled || !ohlcScaled)) {
                // Use increasing delays: 100ms, 200ms, 400ms, 800ms, 1600ms
                const delay = 100 * Math.pow(2, attempt - 1);
                setTimeout(() => forceYAxisScaling(attempt + 1, maxAttempts), delay);
              } else {
                // Reset Y-axis update timer to allow immediate updates after live transition
                lastYAxisUpdateRef.current = 0;
                if (tickScaled || ohlcScaled) {
                  console.log(`[MultiPaneChart] Y-axis auto-scaling completed (attempt ${attempt})`);
                } else {
                  console.warn('[MultiPaneChart] Y-axis auto-scaling failed after all attempts - will retry on next data update');
                }
              }
            } catch (e) {
              console.warn('[MultiPaneChart] Error auto-scaling Y-axis on live transition:', e);
              // Retry on error if we haven't exceeded max attempts
              if (attempt < maxAttempts) {
                const delay = 100 * Math.pow(2, attempt - 1);
                setTimeout(() => forceYAxisScaling(attempt + 1, maxAttempts), delay);
              }
            }
          };
          
          // CRITICAL: Force Y-axis scaling immediately when transitioning to live
          // When there's history data, the data processing loop might not run again,
          // so we need to scale immediately, not just set a flag
          // Also set flag as backup in case new data arrives
          triggerYAxisScalingOnNextBatchRef.current = true;
          
          // Force immediate Y-axis scaling (works even when history is already loaded)
          // Use requestAnimationFrame to ensure the chart is ready
          requestAnimationFrame(() => {
            // Immediate scaling attempt - don't wait for data processing loop
            const scaleYAxisImmediately = () => {
              try {
                const refs = chartRefs.current;
                
                // Scale tick chart Y-axis immediately
                if (refs.tickSurface) {
                  const tickXAxis = refs.tickSurface.xAxes.get(0);
                  const tickYAxis = refs.tickSurface.yAxes.get(0);
                  if (tickXAxis && tickXAxis.visibleRange && tickYAxis) {
                    const xRange = tickXAxis.visibleRange.max - tickXAxis.visibleRange.min;
                    if (xRange >= 60 * 1000) {
                      try {
                        refs.tickSurface.zoomExtentsY();
                        refs.tickSurface.invalidateElement();
                        console.log('[MultiPaneChart] Y-axis auto-scaled (tick) immediately on live transition');
                      } catch (e) {
                        console.warn('[MultiPaneChart] Immediate Y-axis scaling failed for tick chart:', e);
                      }
                    }
                  }
                }
                
                // Scale OHLC chart Y-axis immediately
                if (refs.ohlcSurface) {
                  const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
                  const ohlcYAxis = refs.ohlcSurface.yAxes.get(0);
                  if (ohlcXAxis && ohlcXAxis.visibleRange && ohlcYAxis) {
                    const xRange = ohlcXAxis.visibleRange.max - ohlcXAxis.visibleRange.min;
                    if (xRange >= 60 * 1000) {
                      try {
                        refs.ohlcSurface.zoomExtentsY();
                        refs.ohlcSurface.invalidateElement();
                        console.log('[MultiPaneChart] Y-axis auto-scaled (ohlc) immediately on live transition');
                      } catch (e) {
                        console.warn('[MultiPaneChart] Immediate Y-axis scaling failed for OHLC chart:', e);
                      }
                    }
                  }
                }
              } catch (error) {
                console.warn('[MultiPaneChart] Error in immediate Y-axis scaling:', error);
              }
            };
            
            // Try immediately, then retry with delays if needed
            scaleYAxisImmediately();
            setTimeout(() => scaleYAxisImmediately(), 100);
            setTimeout(() => scaleYAxisImmediately(), 300);
            
            // Also run the retry mechanism as backup
            setTimeout(() => forceYAxisScaling(1, 5), 500);
          });
        } catch (e) {
          console.warn('[MultiPaneChart] Error setting X-axis range on live transition:', e);
        }
      }
    }
    
    // Reset history loaded flag when starting new connection
    if (feedStage === 'history' && prevStage === 'idle') {
      historyLoadedRef.current = false;
      initialDataTimeRef.current = null;
    }
  }, [feedStage]);
  
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
          
          console.log('[MultiPaneChart] Tab hidden - saved X-axis range:', {
            isFullRange,
            tickWidth: savedXAxisRangeRef.current.tickRange.width,
            ohlcWidth: savedXAxisRangeRef.current.ohlcRange.width,
          });
        }
      } else {
        // Tab is becoming visible - process any remaining data first
        // The chart should have been processing in background, but process a few more batches
        // to catch up on any remaining samples, then restore the range smoothly
        if (savedXAxisRangeRef.current && tickXAxis && ohlcXAxis) {
          const saved = savedXAxisRangeRef.current;
          
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
              console.log(`[MultiPaneChart] Tab visible - ${remainingBufferSize} samples pending, setting range first...`);
              
              // Get the latest timestamp from global data clock (registry)
              // This is the requirement: "examine all the data series in the data registry and find the maximum of the timestamps"
              // This is the requirement: "examine all the data series in the data registry and find the maximum of the timestamps"
              let globalDataClock = 0;
              if (registry && registry.length > 0) {
                globalDataClock = Math.max(...registry.map(r => r.lastMs || 0));
              }
              
              // Fallback to lastDataTimeRef if registry is empty or no valid timestamps
              if (globalDataClock === 0 || !isFinite(globalDataClock)) {
                globalDataClock = lastDataTimeRef.current;
              }
              
              // Use global data clock as the source of truth
              const latestTimestamp = globalDataClock > 0 ? globalDataClock : lastDataTimeRef.current;
              
              if (latestTimestamp > 0 && tickXAxis && ohlcXAxis) {
                const windowMs = saved.tickRange.width; // Use saved window width (e.g., 630000ms = 10.5 minutes)
                
                let newTickRange: NumberRange;
                let newOhlcRange: NumberRange;
                
                if (saved.isFullRange) {
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
                  newOhlcRange = new NumberRange(latestTimestamp - saved.ohlcRange.width, latestTimestamp);
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
                
                console.log('[MultiPaneChart] Tab visible - fixed X-axis range to latest position (global data clock):', {
                  from: new Date(newTickRange.min).toISOString(),
                  to: new Date(newTickRange.max).toISOString(),
                  globalDataClock: new Date(globalDataClock).toISOString(),
                  latestTimestamp: new Date(latestTimestamp).toISOString(),
                  windowWidth: windowMs,
                  isFullRange: saved.isFullRange,
                  registrySeriesCount: registry.length,
                  actualTickMax: actualTickMax ? new Date(actualTickMax).toISOString() : 'not set',
                  actualOhlcMax: actualOhlcMax ? new Date(actualOhlcMax).toISOString() : 'not set',
                  dataPointCount: Array.from(refs.dataSeriesStore.values()).reduce((sum, entry) => sum + entry.dataSeries.count(), 0),
                  pendingSamples: remainingBufferSize,
                });
                
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
                    
                    console.log(`[MultiPaneChart] Background processing complete: ${iterations} batches processed`);
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
              console.log('[MultiPaneChart] Auto-scroll re-enabled after range restoration');
            }, 1500); // Extended delay to ensure range is fully stable
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
    }
    
    // Schedule batched update if not already scheduled
    // Use setTimeout fallback when tab is hidden (requestAnimationFrame is throttled)
    if (pendingUpdateRef.current === null) {
      const scheduleNext = () => {
        pendingUpdateRef.current = null;
        processBatchedSamples();
        // If there are more samples, schedule another batch
        if (sampleBufferRef.current.length > 0) {
          // When tab is hidden, use setTimeout instead of requestAnimationFrame
          // Use a longer interval when hidden (100ms) to ensure processing continues
          // but not too fast to avoid browser throttling
          if (document.hidden) {
            isUsingTimeoutRef.current = true;
            // Use 100ms interval when hidden - ensures processing continues but not too aggressive
            // This keeps the chart running in background so it's already at latest position when visible
            pendingUpdateRef.current = setTimeout(scheduleNext, 100);
          } else {
            isUsingTimeoutRef.current = false;
            pendingUpdateRef.current = requestAnimationFrame(scheduleNext);
          }
        }
      };
      
      const now = performance.now();
      const timeSinceLastRender = now - lastRenderTimeRef.current;
      
      if (timeSinceLastRender >= FRAME_INTERVAL_MS) {
        // Render immediately if enough time has passed
        scheduleNext();
      } else {
        // Schedule for next frame - use setTimeout if tab is hidden
        if (document.hidden) {
          isUsingTimeoutRef.current = true;
          // Use 16ms interval when hidden (matches 60fps) - process data aggressively in background
          // This ensures we keep up with incoming data even when tab is hidden
          pendingUpdateRef.current = setTimeout(scheduleNext, 16);
        } else {
          isUsingTimeoutRef.current = false;
          pendingUpdateRef.current = requestAnimationFrame(scheduleNext);
        }
      }
    }
  }, [onDataClockUpdate, processBatchedSamples, config]);

  // Control functions
  const setLiveMode = useCallback((live: boolean) => {
    isLiveRef.current = live;
  }, []);

  const zoomExtents = useCallback(() => {
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

  return {
    isReady,
    appendSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
    chartRefs,
  };
}
