// Layout Engine - Creates and manages chart surfaces from layout JSON
// This is the bridge between layout JSON and SciChart surfaces

import type { PlotLayoutJSON, PaneConfig, SeriesConfig, HLineOverlay, VLineOverlay } from '@/types/layout';
import type { StrategyMarker, MarkerStyle } from '@/types/markers';
import type { ZoomMode } from '@/types/zoom';
import { DEFAULT_MARKER_STYLES } from '@/types/markers';
import { SeriesStore } from './series-store';
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
  TSciChart,
  EAxisAlignment,
  HorizontalLineAnnotation,
  VerticalLineAnnotation,
  ELabelPlacement,
  DpiHelper,
  SciChartDefaults,
  CustomAnnotation,
  ECoordinateMode,
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  EXyDirection,
} from 'scichart';

export interface PaneSurface {
  id: string;
  surface: SciChartSurface;
  wasmContext: TSciChart;
  xAxis: DateTimeNumericAxis;
  yAxis: NumericAxis;
  renderableSeries: Map<string, FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries>;
  dataSeries: Map<string, XyDataSeries | OhlcDataSeries>;
  annotations: Map<string, HorizontalLineAnnotation | VerticalLineAnnotation | CustomAnnotation>;
  markers: Map<string, CustomAnnotation>;
  config: PaneConfig;
  isDeleted: boolean;
}

export interface LayoutEngineState {
  layout: PlotLayoutJSON | null;
  panes: Map<string, PaneSurface>;
  isInitialized: boolean;
  errors: string[];
  markers: StrategyMarker[];
}

type LayoutChangeListener = (state: LayoutEngineState) => void;

// FIFO capacity for chart rendering (not the main data store)
// SeriesStore holds the full 1M+ points, this is just for rendering
const CHART_FIFO_CAPACITY = 50000;

class LayoutEngineClass {
  private state: LayoutEngineState = {
    layout: null,
    panes: new Map(),
    isInitialized: false,
    errors: [],
    markers: [],
  };
  
  private markerStyles: MarkerStyle = DEFAULT_MARKER_STYLES;
  private currentZoomMode: ZoomMode = 'xy';
  
  private listeners: Set<LayoutChangeListener> = new Set();
  private containerRefs: Map<string, HTMLElement> = new Map();
  private drainLoopId: number | null = null;
  private lastDrainTime: number = 0;
  private isLoading: boolean = false; // Lock to prevent double loads
  private wasmInitialized: boolean = false;
  
  // Get current state
  getState(): LayoutEngineState {
    return this.state;
  }
  
  // Check if layout is loaded
  hasLayout(): boolean {
    return this.state.layout !== null;
  }
  
  // Load a layout JSON
  async loadLayout(layout: PlotLayoutJSON, containersMap: Map<string, HTMLDivElement>): Promise<boolean> {
    // Prevent double loads (React StrictMode)
    if (this.isLoading) {
      console.log('[LayoutEngine] Already loading, skipping...');
      return false;
    }
    
    this.isLoading = true;
    console.log('[LayoutEngine] Loading layout:', layout.meta?.name || 'unnamed');
    
    // Store container refs
    this.containerRefs = containersMap;
    
    // Dispose existing surfaces
    await this.disposeAllSurfaces();
    
    // Store new layout
    this.state.layout = layout;
    this.state.errors = [];
    
    try {
      // Initialize SciChart WASM only once
      if (!this.wasmInitialized) {
        SciChartSurface.useWasmFromCDN();
        DpiHelper.IsDpiScaleEnabled = false;
        SciChartDefaults.useNativeText = true;
        // Disable shared cache to avoid potential issues with multiple surfaces
        SciChartDefaults.useSharedCache = false;
        SciChartDefaults.performanceWarnings = false;
        this.wasmInitialized = true;
        
        // Wait for WASM to fully initialize
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      
      // Create surfaces for each pane - with delays to avoid WebGL context race conditions
      for (let i = 0; i < layout.panes.length; i++) {
        const paneConfig = layout.panes[i];
        const container = containersMap.get(paneConfig.id);
        if (!container) {
          this.state.errors.push(`Container not found for pane: ${paneConfig.id}`);
          continue;
        }
        
        console.log(`[LayoutEngine] Creating surface ${i + 1}/${layout.panes.length}: ${paneConfig.id}`);
        await this.createPaneSurface(paneConfig, container);
        
        // Add delay between surface creations to avoid WebGL context issues
        if (i < layout.panes.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      }
      
      // Bind series to panes
      for (const seriesConfig of layout.series) {
        await this.bindSeriesToPane(seriesConfig);
      }
      
      // Apply overlays
      for (const paneConfig of layout.panes) {
        if (paneConfig.overlays) {
          await this.applyOverlays(paneConfig.id, paneConfig.overlays);
        }
      }
      
      // Link X axes
      this.linkXAxes();
      
      // Force all surfaces to recognize their container size and invalidate
      for (const pane of this.state.panes.values()) {
        if (!pane.isDeleted && pane.surface) {
          // Trigger a resize to ensure SciChart recognizes container dimensions
          const container = this.containerRefs.get(pane.id);
          if (container) {
            const rect = container.getBoundingClientRect();
            console.log(`[LayoutEngine] Final container size for ${pane.id}: ${rect.width}x${rect.height}`);
          }
          
          // Force explicit invalidation and render of each surface
          pane.surface.invalidateElement();
          
          // Log the renderable series count and data count for debugging
          console.log(`[LayoutEngine] Surface ${pane.id} has ${pane.surface.renderableSeries.size()} series`);
          pane.dataSeries.forEach((ds, seriesId) => {
            const count = ds.count();
            console.log(`[LayoutEngine] DataSeries ${seriesId} has ${count} points`);
          });
          
          // Check Y axis visible range
          const yRange = pane.yAxis.visibleRange;
          console.log(`[LayoutEngine] Surface ${pane.id} Y axis range: ${yRange?.min} to ${yRange?.max}`);
        }
      }
      
      // Use zoomExtents to show all data initially (this was working before)
      this.zoomExtents();
      
      // Delayed zoomExtents + jumpToLive to ensure rendering completes and show recent data
      setTimeout(() => {
        this.zoomExtents();
        console.log('[LayoutEngine] Delayed zoomExtents applied');
        // Jump to live to show last 60 seconds where all series should have data
        this.jumpToLive();
        console.log('[LayoutEngine] Auto-jumped to live data');
      }, 500);
      
      // Third delayed check for full rendering
      setTimeout(() => {
        for (const pane of this.state.panes.values()) {
          if (!pane.isDeleted && pane.surface) {
            pane.dataSeries.forEach((ds, seriesId) => {
              const count = ds.count();
              const xRange = count > 0 ? ds.getXRange() : null;
              // Calculate Y range manually using correct API
              let minY = Infinity, maxY = -Infinity;
              if (count > 0) {
                if ('highValues' in ds) {
                  const ohlc = ds as OhlcDataSeries;
                  const hVals = ohlc.getNativeHighValues();
                  const lVals = ohlc.getNativeLowValues();
                  for (let i = 0; i < count; i++) {
                    const h = hVals.get(i);
                    const l = lVals.get(i);
                    if (l < minY) minY = l;
                    if (h > maxY) maxY = h;
                  }
                } else {
                  const xy = ds as XyDataSeries;
                  const yVals = xy.getNativeYValues();
                  for (let i = 0; i < count; i++) {
                    const y = yVals.get(i);
                    if (y < minY) minY = y;
                    if (y > maxY) maxY = y;
                  }
                }
              }
              const yStr = minY < Infinity ? `${minY.toFixed(2)}-${maxY.toFixed(2)}` : 'no data';
              console.log(`[LayoutEngine] FINAL CHECK ${seriesId}: ${count} pts, X=${xRange?.min?.toFixed(0)}-${xRange?.max?.toFixed(0)}, Y=${yStr}`);
            });
            // Also log actual Y axis visible range
            const yAxisRange = pane.yAxis.visibleRange;
            console.log(`[LayoutEngine] ${pane.id} Y-axis visible: ${yAxisRange.min.toFixed(2)} to ${yAxisRange.max.toFixed(2)}`);
          }
        }
      }, 1000);
      
      // Start drain loop
      this.startDrainLoop();
      
      this.state.isInitialized = true;
      this.isLoading = false;
      this.notifyListeners();
      
      console.log('[LayoutEngine] Layout loaded successfully');
      return true;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      this.state.errors.push(error);
      console.error('[LayoutEngine] Failed to load layout:', e);
      this.isLoading = false;
      this.notifyListeners();
      return false;
    }
  }
  
  private async createPaneSurface(config: PaneConfig, container: HTMLDivElement): Promise<void> {
    // Debug: Check container dimensions
    const rect = container.getBoundingClientRect();
    console.log(`[LayoutEngine] Container ${config.id} dimensions: ${rect.width}x${rect.height}`);
    
    if (rect.width === 0 || rect.height === 0) {
      console.warn(`[LayoutEngine] Container ${config.id} has zero dimensions! Waiting for layout...`);
      // Wait for layout to complete
      await new Promise(resolve => setTimeout(resolve, 300));
      const rect2 = container.getBoundingClientRect();
      console.log(`[LayoutEngine] Container ${config.id} after wait: ${rect2.width}x${rect2.height}`);
    }
    
    try {
      const { sciChartSurface, wasmContext } = await SciChartSurface.create(container, {
        theme: {
          type: 'Dark',
          sciChartBackground: '#1c2027',
          loadingAnimationBackground: '#1c2027',
          loadingAnimationForeground: '#50C7E0',
          majorGridLineBrush: '#2a3040',
          minorGridLineBrush: '#1e2530',
          tickTextBrush: '#9fb2c9',
        },
      });
      
      // Debug: Verify surface was created with canvas
      const canvas = container.querySelector('canvas');
      console.log(`[LayoutEngine] Surface ${config.id} created, canvas present: ${!!canvas}, canvas size: ${canvas?.width}x${canvas?.height}`);
      
      // Add WebGL context lost listener (but don't try to acquire context - SciChart owns it)
      if (canvas) {
        canvas.addEventListener('webglcontextlost', (e) => {
          console.error(`[LayoutEngine] WebGL context LOST for ${config.id}!`);
          e.preventDefault(); // Try to restore context
        });
        canvas.addEventListener('webglcontextrestored', () => {
          console.log(`[LayoutEngine] WebGL context restored for ${config.id}`);
          // Try to invalidate surface to force redraw
          const pane = this.state.panes.get(config.id);
          if (pane && !pane.isDeleted) {
            pane.surface.invalidateElement();
          }
        });
      }
      
      // Create X axis (DateTime) - use Always initially, switch to Never when we set manual ranges
      // EAutoRange.Once fails because it calculates range before data arrives
      // EAutoRange.Always will keep auto-ranging until we explicitly set Never + manual range
      const xAxis = new DateTimeNumericAxis(wasmContext, {
        axisAlignment: EAxisAlignment.Bottom,
        autoRange: EAutoRange.Always, // Auto-range until jumpToLive sets manual range
        drawMajorGridLines: true,
        drawMinorGridLines: false,
        drawMajorBands: false,
      });
      
      // Create Y axis - use Always initially, will dynamically update with visible data
      const yAxis = new NumericAxis(wasmContext, {
        axisAlignment: EAxisAlignment.Right,
        autoRange: EAutoRange.Always, // Keep auto-ranging to fit visible data
        drawMajorGridLines: true,
        drawMinorGridLines: false,
        drawMajorBands: false,
        growBy: new NumberRange(0.1, 0.1), // 10% padding above/below data
      });
      
      sciChartSurface.xAxes.add(xAxis);
      sciChartSurface.yAxes.add(yAxis);
      
      // Add modifiers
      sciChartSurface.chartModifiers.add(
        new ZoomPanModifier(),
        new ZoomExtentsModifier(),
        new MouseWheelZoomModifier(),
        new RubberBandXyZoomModifier(),
        new XAxisDragModifier(),
        new YAxisDragModifier()
      );
      
      const paneSurface: PaneSurface = {
        id: config.id,
        surface: sciChartSurface,
        wasmContext,
        xAxis,
        yAxis,
        renderableSeries: new Map(),
        dataSeries: new Map(),
        annotations: new Map(),
        markers: new Map(),
        config,
        isDeleted: false,
      };
      
      this.state.panes.set(config.id, paneSurface);
      console.log(`[LayoutEngine] Created pane surface: ${config.id}`);
    } catch (err) {
      console.error(`[LayoutEngine] Failed to create surface for ${config.id}:`, err);
      throw err;
    }
  }
  
  private async bindSeriesToPane(config: SeriesConfig): Promise<void> {
    const pane = this.state.panes.get(config.pane);
    if (!pane) {
      this.state.errors.push(`Cannot bind series ${config.series_id}: pane ${config.pane} not found`);
      return;
    }
    
    const { wasmContext, surface } = pane;
    
    let dataSeries: XyDataSeries | OhlcDataSeries;
    let renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries;
    
    switch (config.type) {
      case 'FastCandlestickRenderableSeries':
        dataSeries = new OhlcDataSeries(wasmContext, {
          dataSeriesName: config.series_id,
          fifoCapacity: CHART_FIFO_CAPACITY,
        });
        renderableSeries = new FastCandlestickRenderableSeries(wasmContext, {
          dataSeries: dataSeries as OhlcDataSeries,
          strokeUp: '#26a69a',
          brushUp: '#26a69a88',
          strokeDown: '#ef5350',
          brushDown: '#ef535088',
        });
        break;
        
      case 'FastMountainRenderableSeries':
        dataSeries = new XyDataSeries(wasmContext, {
          dataSeriesName: config.series_id,
          fifoCapacity: CHART_FIFO_CAPACITY,
        });
        renderableSeries = new FastMountainRenderableSeries(wasmContext, {
          dataSeries: dataSeries as XyDataSeries,
          stroke: config.color || '#50C7E0',
          strokeThickness: config.strokeThickness || 1,
          fill: (config.color || '#50C7E0') + '33',
        });
        break;
        
      case 'FastLineRenderableSeries':
      default:
        dataSeries = new XyDataSeries(wasmContext, {
          dataSeriesName: config.series_id,
          fifoCapacity: CHART_FIFO_CAPACITY,
        });
        renderableSeries = new FastLineRenderableSeries(wasmContext, {
          dataSeries: dataSeries as XyDataSeries,
          stroke: config.color || '#50C7E0',
          strokeThickness: config.strokeThickness || 1,
        });
        break;
    }
    
    surface.renderableSeries.add(renderableSeries);
    pane.dataSeries.set(config.series_id, dataSeries);
    pane.renderableSeries.set(config.series_id, renderableSeries);
    
    // Ensure series is visible
    renderableSeries.isVisible = true;
    
    // Debug: verify series was added
    console.log(`[LayoutEngine] Surface ${config.pane} now has ${surface.renderableSeries.size()} renderable series, isVisible: ${renderableSeries.isVisible}`);
    
    // If data already exists in store, populate immediately
    const existingData = SeriesStore.getLinearizedData(config.series_id);
    if (existingData && existingData.x.length > 0) {
      const dataToAppend = Math.min(existingData.x.length, CHART_FIFO_CAPACITY - 100);
      const startIdx = Math.max(0, existingData.x.length - dataToAppend);
      
      // Debug: Log sample values for tick series
      if (config.series_id.includes(':ticks') || config.series_id.includes(':ohlc')) {
        console.log(`[LayoutEngine] Initial population for ${config.series_id}:`, {
          totalPoints: existingData.x.length,
          appendingPoints: dataToAppend,
          startIdx,
          sampleX: existingData.x[startIdx],
          sampleY: existingData.y[startIdx],
          hasOHLC: !!existingData.o,
        });
      }
      
      if (config.type === 'FastCandlestickRenderableSeries' && existingData.o) {
        (dataSeries as OhlcDataSeries).appendRange(
          existingData.x.slice(startIdx),
          existingData.o.slice(startIdx),
          existingData.h!.slice(startIdx),
          existingData.l!.slice(startIdx),
          existingData.c!.slice(startIdx)
        );
        console.log(`[LayoutEngine] OHLC ${config.series_id}: appended ${dataToAppend} points`);
      } else {
        (dataSeries as XyDataSeries).appendRange(
          existingData.x.slice(startIdx),
          existingData.y.slice(startIdx)
        );
        console.log(`[LayoutEngine] XY ${config.series_id}: appended ${dataToAppend} points`);
      }
      
      // Don't set autoRange here - we'll set ranges manually in zoomExtents
      surface.invalidateElement();
    }
    
    console.log(`[LayoutEngine] Bound series ${config.series_id} to pane ${config.pane}`);
  }
  
  private async applyOverlays(paneId: string, overlays: { hline?: HLineOverlay[]; vline?: VLineOverlay[] }): Promise<void> {
    const pane = this.state.panes.get(paneId);
    if (!pane) return;
    
    // Apply horizontal lines
    if (overlays.hline) {
      for (const hline of overlays.hline) {
        const annotation = new HorizontalLineAnnotation({
          y1: hline.y,
          stroke: hline.color || '#666666',
          strokeThickness: hline.strokeThickness || 1,
          strokeDashArray: hline.style?.strokeDashArray,
          labelPlacement: ELabelPlacement.TopRight,
          labelValue: hline.label,
          showLabel: !!hline.label,
        });
        pane.surface.annotations.add(annotation);
        pane.annotations.set(`hline_${hline.id}`, annotation);
      }
    }
    
    // Apply vertical lines
    if (overlays.vline) {
      for (const vline of overlays.vline) {
        const annotation = new VerticalLineAnnotation({
          x1: vline.x,
          stroke: vline.color || '#666666',
          strokeThickness: vline.strokeThickness || 1,
          strokeDashArray: vline.style?.strokeDashArray,
          labelPlacement: ELabelPlacement.TopRight,
          labelValue: vline.label,
          showLabel: !!vline.label,
        });
        pane.surface.annotations.add(annotation);
        pane.annotations.set(`vline_${vline.id}`, annotation);
      }
    }
    
    console.log(`[LayoutEngine] Applied overlays to pane ${paneId}`);
  }
  
  private linkXAxes(): void {
    // Link all X axes so they scroll together
    const panes = Array.from(this.state.panes.values());
    if (panes.length < 2) {
      console.log(`[LayoutEngine] Only ${panes.length} pane(s), no linking needed`);
      return;
    }
    
    const primaryXAxis = panes[0].xAxis;
    let isSyncing = false; // Prevent infinite loops
    
    for (let i = 1; i < panes.length; i++) {
      const xAxis = panes[i].xAxis;
      
      // Sync visible range changes from primary to secondary
      primaryXAxis.visibleRangeChanged.subscribe((args) => {
        if (isSyncing || !args.visibleRange) return;
        isSyncing = true;
        try {
          xAxis.visibleRange = new NumberRange(args.visibleRange.min, args.visibleRange.max);
        } finally {
          isSyncing = false;
        }
      });
      
      // Sync visible range changes from secondary to primary
      xAxis.visibleRangeChanged.subscribe((args) => {
        if (isSyncing || !args.visibleRange) return;
        isSyncing = true;
        try {
          primaryXAxis.visibleRange = new NumberRange(args.visibleRange.min, args.visibleRange.max);
          // Also sync to other secondary axes
          for (let j = 1; j < panes.length; j++) {
            if (j !== i) {
              panes[j].xAxis.visibleRange = new NumberRange(args.visibleRange.min, args.visibleRange.max);
            }
          }
        } finally {
          isSyncing = false;
        }
      });
    }
    
    console.log(`[LayoutEngine] Linked X axes across ${panes.length} panes`);
  }
  
  // Live mode state for auto-scrolling
  private liveMode: boolean = true;
  private lastAutoScrollTime: number = 0;
  
  // Set live mode
  setLiveMode(live: boolean): void {
    this.liveMode = live;
    console.log(`[LayoutEngine] Live mode: ${live}`);
    if (live) {
      this.jumpToLive();
    }
  }
  
  getLiveMode(): boolean {
    return this.liveMode;
  }
  
  // Drain loop - transfers data from SeriesStore to chart DataSeries
  private startDrainLoop(): void {
    if (this.drainLoopId !== null) return;
    
    const drain = () => {
      const now = performance.now();
      if (now - this.lastDrainTime < 16) { // ~60fps
        this.drainLoopId = requestAnimationFrame(drain);
        return;
      }
      this.lastDrainTime = now;
      
      // Drain dirty series
      const dirtySeries = SeriesStore.getDirtySeries();
      let dataAppended = false;
      
      for (const seriesId of dirtySeries) {
        const appended = this.drainSeries(seriesId);
        if (appended) dataAppended = true;
        SeriesStore.markClean(seriesId);
      }
      
      // Auto-scroll if in live mode and new data was appended
      if (this.liveMode && dataAppended) {
        const timeSinceLastScroll = now - this.lastAutoScrollTime;
        if (timeSinceLastScroll > 100) { // Throttle to 10Hz
          this.jumpToLive();
          this.lastAutoScrollTime = now;
        }
      }
      
      this.drainLoopId = requestAnimationFrame(drain);
    };
    
    this.drainLoopId = requestAnimationFrame(drain);
    console.log('[LayoutEngine] Started drain loop');
  }
  
  private drainSeries(seriesId: string): boolean {
    // Find which pane has this series
    let foundInPane = false;
    let dataAppended = false;
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      const dataSeries = pane.dataSeries.get(seriesId);
      if (!dataSeries) continue;
      
      foundInPane = true;
      const data = SeriesStore.getLinearizedData(seriesId);
      if (!data || data.x.length === 0) {
        continue;
      }
      
      // Simple approach: append newest data that chart doesn't have yet
      // Use count comparison - if store has more data, append the difference
      const currentCount = dataSeries.count();
      const storeCount = data.x.length;
      
      // If chart is full (FIFO), we need to track by timestamp instead
      if (currentCount >= CHART_FIFO_CAPACITY - 100) {
        // Chart FIFO is nearly full - use timestamp-based sync
        const chartMaxX = dataSeries.getXRange().max;
        const storeMaxX = data.x[data.x.length - 1];
        
        if (storeMaxX <= chartMaxX) continue;
        
        // Find first index in store with X > chartMaxX
        let startIdx = data.x.length;
        for (let i = data.x.length - 1; i >= 0; i--) {
          if (data.x[i] <= chartMaxX) {
            startIdx = i + 1;
            break;
          }
          if (i === 0) startIdx = 0;
        }
        
        if (startIdx >= data.x.length) continue;
        
        try {
          pane.surface.suspendUpdates();
          
          if ('appendRange' in dataSeries && data.o) {
            (dataSeries as OhlcDataSeries).appendRange(
              data.x.slice(startIdx),
              data.o.slice(startIdx),
              data.h!.slice(startIdx),
              data.l!.slice(startIdx),
              data.c!.slice(startIdx)
            );
          } else {
            (dataSeries as XyDataSeries).appendRange(
              data.x.slice(startIdx),
              data.y.slice(startIdx)
            );
          }
          
          pane.surface.resumeUpdates();
          dataAppended = true;
        } catch (e) {
          console.error(`[LayoutEngine] Error draining ${seriesId}:`, e);
        }
      } else {
        // Chart has room - use simple count-based sync
        if (storeCount <= currentCount) continue;
        
        const newDataCount = storeCount - currentCount;
        const appendCount = Math.min(newDataCount, 5000);
        const startIdx = storeCount - appendCount;
        
        try {
          pane.surface.suspendUpdates();
          
          if ('appendRange' in dataSeries && data.o) {
            (dataSeries as OhlcDataSeries).appendRange(
              data.x.slice(startIdx),
              data.o.slice(startIdx),
              data.h!.slice(startIdx),
              data.l!.slice(startIdx),
              data.c!.slice(startIdx)
            );
          } else {
            (dataSeries as XyDataSeries).appendRange(
              data.x.slice(startIdx),
              data.y.slice(startIdx)
            );
          }
          
          pane.surface.resumeUpdates();
          dataAppended = true;
        } catch (e) {
          console.error(`[LayoutEngine] Error draining ${seriesId}:`, e);
        }
      }
    }
    
    if (!foundInPane && !this._loggedUnmatchedSeries.has(seriesId)) {
      this._loggedUnmatchedSeries.add(seriesId);
      console.warn(`[LayoutEngine] Series ${seriesId} in store but NOT in layout`);
    }
    
    return dataAppended;
  }
  
  private _loggedUnmatchedSeries: Set<string> = new Set();
  
  private stopDrainLoop(): void {
    if (this.drainLoopId !== null) {
      cancelAnimationFrame(this.drainLoopId);
      this.drainLoopId = null;
    }
  }
  
  // Dispose all surfaces
  async disposeAllSurfaces(): Promise<void> {
    this.stopDrainLoop();
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      try {
        pane.isDeleted = true;
        pane.surface.delete();
      } catch (e) {
        // Ignore - surface may already be deleted
      }
    }
    
    this.state.panes.clear();
    this.state.isInitialized = false;
    console.log('[LayoutEngine] Disposed all surfaces');
  }
  
  // Get pane for a series
  getPaneForSeries(seriesId: string): PaneSurface | null {
    for (const pane of this.state.panes.values()) {
      if (pane.dataSeries.has(seriesId)) {
        return pane;
      }
    }
    return null;
  }
  
  // Move a series from one pane to another
  moveSeriesToPane(seriesId: string, targetPaneId: string): boolean {
    const sourcePane = this.getPaneForSeries(seriesId);
    const targetPane = this.state.panes.get(targetPaneId);
    
    if (!sourcePane || !targetPane) {
      console.error(`[LayoutEngine] Cannot move series: source or target pane not found`);
      return false;
    }
    
    if (sourcePane.id === targetPaneId) {
      console.warn(`[LayoutEngine] Series ${seriesId} already in pane ${targetPaneId}`);
      return false;
    }
    
    try {
      // Get the data series and renderable series from source
      const dataSeries = sourcePane.dataSeries.get(seriesId);
      const renderableSeries = sourcePane.renderableSeries.get(seriesId);
      
      if (!dataSeries || !renderableSeries) {
        console.error(`[LayoutEngine] Series ${seriesId} not found in source pane`);
        return false;
      }
      
      // Remove from source pane
      sourcePane.surface.renderableSeries.remove(renderableSeries);
      sourcePane.dataSeries.delete(seriesId);
      sourcePane.renderableSeries.delete(seriesId);
      
      // Add to target pane
      targetPane.surface.renderableSeries.add(renderableSeries);
      targetPane.dataSeries.set(seriesId, dataSeries);
      targetPane.renderableSeries.set(seriesId, renderableSeries);
      
      console.log(`[LayoutEngine] Moved series ${seriesId} from ${sourcePane.id} to ${targetPaneId}`);
      this.notifyListeners();
      return true;
    } catch (e) {
      console.error(`[LayoutEngine] Error moving series:`, e);
      return false;
    }
  }
  
  // Subscribe to state changes
  subscribe(listener: LayoutChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  
  private notifyListeners(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.state);
      } catch (e) {
        console.error('[LayoutEngine] Listener error:', e);
      }
    }
  }
  
  // Set visibility for all series based on the provided set
  // If the set is empty, keep all series visible (don't hide everything)
  setSeriesVisibility(visibleSeries: Set<string>): void {
    // If empty set, don't change visibility - this prevents hiding all series on init
    if (visibleSeries.size === 0) {
      return;
    }
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      for (const [seriesId, renderableSeries] of pane.renderableSeries) {
        const shouldBeVisible = visibleSeries.has(seriesId);
        if (renderableSeries.isVisible !== shouldBeVisible) {
          renderableSeries.isVisible = shouldBeVisible;
        }
      }
      
      // Invalidate surface to apply visibility changes
      pane.surface.invalidateElement();
    }
  }
  
  // Zoom extents on all panes - calculate unified X range then per-pane Y ranges
  zoomExtents(): void {
    // PHASE 1: Calculate unified X range (intersection of all panes' data)
    let globalMinX = -Infinity;  // We want the MAXIMUM of all minimums (intersection start)
    let globalMaxX = Infinity;   // We want the MINIMUM of all maximums (intersection end)
    let hasAnyData = false;
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      let paneMinX = Infinity, paneMaxX = -Infinity;
      let paneHasData = false;
      
      for (const dataSeries of pane.dataSeries.values()) {
        const count = dataSeries.count();
        if (count === 0) continue;
        paneHasData = true;
        
        const xRange = dataSeries.getXRange();
        if (xRange.min < paneMinX) paneMinX = xRange.min;
        if (xRange.max > paneMaxX) paneMaxX = xRange.max;
      }
      
      if (paneHasData) {
        hasAnyData = true;
        // For intersection, take max of mins and min of maxs
        if (paneMinX > globalMinX) globalMinX = paneMinX;
        if (paneMaxX < globalMaxX) globalMaxX = paneMaxX;
      }
    }
    
    // If intersection is invalid (no overlap), fall back to union
    if (globalMinX >= globalMaxX) {
      console.log('[LayoutEngine] No X range intersection, using recent 60 seconds');
      this.jumpToLive();
      return;
    }
    
    console.log(`[LayoutEngine] Unified X range: ${globalMinX.toFixed(0)} - ${globalMaxX.toFixed(0)}`);
    
    // PHASE 2: For each pane, set X range and let Y auto-range
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      // Set X range manually
      pane.xAxis.autoRange = EAutoRange.Never;
      pane.xAxis.visibleRange = new NumberRange(globalMinX, globalMaxX);
      
      // Let Y axis auto-range - SciChart will calculate based on visible X data
      pane.yAxis.autoRange = EAutoRange.Always;
      
      console.log(`[LayoutEngine] zoomExtents ${pane.id}: X=${globalMinX.toFixed(0)}-${globalMaxX.toFixed(0)}, Y=auto`);
      
      pane.surface.invalidateElement();
    }
  }
  
  // Jump to live (scroll to latest data)
  jumpToLive(): void {
    const allEntries = SeriesStore.getAllEntries();
    let maxTimeMs = 0;
    
    for (const entry of allEntries.values()) {
      if (entry.metadata.lastMs > maxTimeMs) {
        maxTimeMs = entry.metadata.lastMs;
      }
    }
    
    if (maxTimeMs === 0) {
      return;
    }
    
    // Convert to seconds for DateTimeNumericAxis
    const maxTimeSec = maxTimeMs / 1000;
    
    // Set visible range to show last 60 seconds of data with 5s padding on right
    const windowSec = 60;
    const paddingSec = 5;
    const minTimeSec = maxTimeSec - windowSec;
    const xRange = new NumberRange(minTimeSec, maxTimeSec + paddingSec);
    
    for (const pane of this.state.panes.values()) {
      if (!pane.isDeleted) {
        // Take manual control of X axis for live scrolling
        pane.xAxis.autoRange = EAutoRange.Never;
        pane.xAxis.visibleRange = xRange;
        
        // Keep Y axis in auto-range mode - it will adjust to visible X data automatically
        // This is simpler and more reliable than manual Y calculation
        pane.yAxis.autoRange = EAutoRange.Always;
        
        pane.surface.invalidateElement();
      }
    }
  }
  
  private _debuggedPanes: Set<string> = new Set(); // For one-time debug logging
  
  // Reset loading state (for cleanup)
  resetLoadingState(): void {
    this.isLoading = false;
  }
  
  // Add a strategy marker to all applicable panes
  addMarker(marker: StrategyMarker): void {
    const layout = this.state.layout;
    const includePanes = layout?.strategy_markers?.include_panes;
    const excludePanes = layout?.strategy_markers?.exclude_panes;
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      // Skip if not in include list (when specified)
      if (includePanes && !includePanes.includes(pane.id)) continue;
      
      // Skip excluded panes
      if (excludePanes && excludePanes.includes(pane.id)) continue;
      
      // Skip PnL and bar panes by default
      if (pane.config.isPnL || pane.config.isBar) continue;
      
      this.addMarkerToPane(pane, marker);
    }
    
    // Track marker
    this.state.markers.push(marker);
  }
  
  private addMarkerToPane(pane: PaneSurface, marker: StrategyMarker): void {
    const style = this.markerStyles[marker.type];
    const color = marker.color || style.color;
    const size = marker.size || style.size;
    
    // Create SVG for marker
    const svg = this.createMarkerSvg(marker.type, color, size);
    
    const annotation = new CustomAnnotation({
      x1: marker.timestamp,
      y1: marker.price,
      xCoordinateMode: ECoordinateMode.DataValue,
      yCoordinateMode: ECoordinateMode.DataValue,
      horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
      verticalAnchorPoint: marker.type === 'buy' || marker.type === 'entry' 
        ? EVerticalAnchorPoint.Top 
        : EVerticalAnchorPoint.Bottom,
      svgString: svg,
    });
    
    pane.surface.annotations.add(annotation);
    pane.markers.set(marker.id, annotation);
  }
  
  private createMarkerSvg(type: StrategyMarker['type'], color: string, size: number): string {
    switch (type) {
      case 'buy':
      case 'entry':
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}">
          <path d="M12 2L2 22h20L12 2z"/>
        </svg>`;
      case 'sell':
      case 'exit':
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}">
          <path d="M12 22L2 2h20L12 22z"/>
        </svg>`;
      case 'stop':
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${color}" stroke-width="3">
          <line x1="4" y1="4" x2="20" y2="20"/>
          <line x1="20" y1="4" x2="4" y2="20"/>
        </svg>`;
      case 'target':
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}">
          <circle cx="12" cy="12" r="10"/>
          <circle cx="12" cy="12" r="4" fill="white"/>
        </svg>`;
      default:
        return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="${color}">
          <circle cx="12" cy="12" r="10"/>
        </svg>`;
    }
  }
  
  // Remove a marker by ID
  removeMarker(markerId: string): void {
    for (const pane of this.state.panes.values()) {
      const annotation = pane.markers.get(markerId);
      if (annotation) {
        pane.surface.annotations.remove(annotation);
        pane.markers.delete(markerId);
      }
    }
    
    this.state.markers = this.state.markers.filter(m => m.id !== markerId);
  }
  
  // Clear all markers
  clearMarkers(): void {
    for (const pane of this.state.panes.values()) {
      for (const annotation of pane.markers.values()) {
        pane.surface.annotations.remove(annotation);
      }
      pane.markers.clear();
    }
    
    this.state.markers = [];
  }
  
  // Get all markers
  getMarkers(): StrategyMarker[] {
    return [...this.state.markers];
  }
  
  // Get current zoom mode
  getZoomMode(): ZoomMode {
    return this.currentZoomMode;
  }
  
  // Set zoom mode for all panes
  setZoomMode(mode: ZoomMode): void {
    this.currentZoomMode = mode;
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      // Find rubber band modifier and update its direction
      const rubberBand = pane.surface.chartModifiers.asArray().find(
        m => m instanceof RubberBandXyZoomModifier
      ) as RubberBandXyZoomModifier | undefined;
      
      if (rubberBand) {
        switch (mode) {
          case 'x':
            rubberBand.xyDirection = EXyDirection.XDirection;
            break;
          case 'y':
            rubberBand.xyDirection = EXyDirection.YDirection;
            break;
          case 'xy':
          case 'box':
          default:
            rubberBand.xyDirection = EXyDirection.XyDirection;
            break;
        }
      }
      
      // Update mouse wheel zoom direction
      const mouseWheel = pane.surface.chartModifiers.asArray().find(
        m => m instanceof MouseWheelZoomModifier
      ) as MouseWheelZoomModifier | undefined;
      
      if (mouseWheel) {
        switch (mode) {
          case 'x':
            mouseWheel.xyDirection = EXyDirection.XDirection;
            break;
          case 'y':
            mouseWheel.xyDirection = EXyDirection.YDirection;
            break;
          default:
            mouseWheel.xyDirection = EXyDirection.XyDirection;
            break;
        }
      }
    }
    
    console.log(`[LayoutEngine] Zoom mode set to: ${mode}`);
  }
}

// Singleton instance
export const LayoutEngine = new LayoutEngineClass();
