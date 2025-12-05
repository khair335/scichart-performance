// Layout Engine - Creates and manages chart surfaces from layout JSON
// This is the bridge between layout JSON and SciChart surfaces

import type { PlotLayoutJSON, PaneConfig, SeriesConfig, HLineOverlay, VLineOverlay } from '@/types/layout';
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
} from 'scichart';

export interface PaneSurface {
  id: string;
  surface: SciChartSurface;
  wasmContext: TSciChart;
  xAxis: DateTimeNumericAxis;
  yAxis: NumericAxis;
  renderableSeries: Map<string, FastLineRenderableSeries | FastCandlestickRenderableSeries | FastMountainRenderableSeries>;
  dataSeries: Map<string, XyDataSeries | OhlcDataSeries>;
  annotations: Map<string, HorizontalLineAnnotation | VerticalLineAnnotation>;
  config: PaneConfig;
  isDeleted: boolean;
}

export interface LayoutEngineState {
  layout: PlotLayoutJSON | null;
  panes: Map<string, PaneSurface>;
  isInitialized: boolean;
  errors: string[];
}

type LayoutChangeListener = (state: LayoutEngineState) => void;

// Safe FIFO capacity - smaller to avoid WASM memory issues
const SAFE_FIFO_CAPACITY = 10000;

class LayoutEngineClass {
  private state: LayoutEngineState = {
    layout: null,
    panes: new Map(),
    isInitialized: false,
    errors: [],
  };
  
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
        SciChartDefaults.useSharedCache = true;
        this.wasmInitialized = true;
        
        // Wait for WASM to fully initialize
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      // Create surfaces for each pane
      for (const paneConfig of layout.panes) {
        const container = containersMap.get(paneConfig.id);
        if (!container) {
          this.state.errors.push(`Container not found for pane: ${paneConfig.id}`);
          continue;
        }
        
        await this.createPaneSurface(paneConfig, container);
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
    
    // Create X axis (DateTime)
    const xAxis = new DateTimeNumericAxis(wasmContext, {
      axisAlignment: EAxisAlignment.Bottom,
      autoRange: EAutoRange.Always,
      drawMajorGridLines: true,
      drawMinorGridLines: false,
      drawMajorBands: false,
    });
    
    // Create Y axis
    const yAxis = new NumericAxis(wasmContext, {
      axisAlignment: EAxisAlignment.Right,
      autoRange: EAutoRange.Always,
      drawMajorGridLines: true,
      drawMinorGridLines: false,
      drawMajorBands: false,
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
      config,
      isDeleted: false,
    };
    
    this.state.panes.set(config.id, paneSurface);
    console.log(`[LayoutEngine] Created pane surface: ${config.id}`);
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
          fifoCapacity: SAFE_FIFO_CAPACITY,
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
          fifoCapacity: SAFE_FIFO_CAPACITY,
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
          fifoCapacity: SAFE_FIFO_CAPACITY,
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
    
    // If data already exists in store, populate immediately
    const existingData = SeriesStore.getLinearizedData(config.series_id);
    if (existingData && existingData.x.length > 0) {
      const dataToAppend = Math.min(existingData.x.length, SAFE_FIFO_CAPACITY - 100);
      const startIdx = Math.max(0, existingData.x.length - dataToAppend);
      
      if (config.type === 'FastCandlestickRenderableSeries' && existingData.o) {
        (dataSeries as OhlcDataSeries).appendRange(
          existingData.x.slice(startIdx),
          existingData.o.slice(startIdx),
          existingData.h!.slice(startIdx),
          existingData.l!.slice(startIdx),
          existingData.c!.slice(startIdx)
        );
      } else {
        (dataSeries as XyDataSeries).appendRange(
          existingData.x.slice(startIdx),
          existingData.y.slice(startIdx)
        );
      }
      console.log(`[LayoutEngine] Populated ${config.series_id} with ${dataToAppend} existing points`);
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
    if (panes.length < 2) return;
    
    const primaryXAxis = panes[0].xAxis;
    
    for (let i = 1; i < panes.length; i++) {
      const xAxis = panes[i].xAxis;
      
      // Sync visible range changes
      primaryXAxis.visibleRangeChanged.subscribe((args) => {
        if (args.visibleRange) {
          xAxis.visibleRange = new NumberRange(args.visibleRange.min, args.visibleRange.max);
        }
      });
      
      xAxis.visibleRangeChanged.subscribe((args) => {
        if (args.visibleRange) {
          primaryXAxis.visibleRange = new NumberRange(args.visibleRange.min, args.visibleRange.max);
        }
      });
    }
    
    console.log(`[LayoutEngine] Linked X axes across ${panes.length} panes`);
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
      for (const seriesId of dirtySeries) {
        this.drainSeries(seriesId);
        SeriesStore.markClean(seriesId);
      }
      
      this.drainLoopId = requestAnimationFrame(drain);
    };
    
    this.drainLoopId = requestAnimationFrame(drain);
    console.log('[LayoutEngine] Started drain loop');
  }
  
  private drainSeries(seriesId: string): void {
    // Find which pane has this series
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      const dataSeries = pane.dataSeries.get(seriesId);
      if (!dataSeries) continue;
      
      const data = SeriesStore.getLinearizedData(seriesId);
      if (!data || data.x.length === 0) continue;
      
      // Get current count in chart
      const currentCount = dataSeries.count();
      const newCount = data.x.length;
      
      if (newCount <= currentCount) continue;
      
      // Append only new data (limited to avoid overflow)
      const startIdx = currentCount;
      const maxAppend = SAFE_FIFO_CAPACITY - currentCount - 100;
      if (maxAppend <= 0) continue;
      
      const appendCount = Math.min(newCount - currentCount, maxAppend);
      if (appendCount <= 0) continue;
      
      try {
        pane.surface.suspendUpdates();
        
        if ('appendRange' in dataSeries && data.o) {
          // OHLC
          const ohlcDs = dataSeries as OhlcDataSeries;
          ohlcDs.appendRange(
            data.x.slice(startIdx, startIdx + appendCount),
            data.o.slice(startIdx, startIdx + appendCount),
            data.h!.slice(startIdx, startIdx + appendCount),
            data.l!.slice(startIdx, startIdx + appendCount),
            data.c!.slice(startIdx, startIdx + appendCount)
          );
        } else {
          // XY
          const xyDs = dataSeries as XyDataSeries;
          xyDs.appendRange(
            data.x.slice(startIdx, startIdx + appendCount),
            data.y.slice(startIdx, startIdx + appendCount)
          );
        }
        
        pane.surface.resumeUpdates();
      } catch (e) {
        console.error(`[LayoutEngine] Error draining ${seriesId}:`, e);
      }
    }
  }
  
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
  
  // Zoom extents on all panes
  zoomExtents(): void {
    for (const pane of this.state.panes.values()) {
      if (!pane.isDeleted) {
        pane.surface.zoomExtents();
      }
    }
  }
  
  // Jump to live (scroll to latest data)
  jumpToLive(): void {
    const allEntries = SeriesStore.getAllEntries();
    let maxTime = 0;
    
    for (const entry of allEntries.values()) {
      if (entry.metadata.lastMs > maxTime) {
        maxTime = entry.metadata.lastMs;
      }
    }
    
    if (maxTime === 0) return;
    
    // Set visible range to show last 5 minutes of data
    const windowMs = 5 * 60 * 1000;
    const minTime = Math.max(0, maxTime - windowMs);
    
    for (const pane of this.state.panes.values()) {
      if (!pane.isDeleted) {
        pane.xAxis.visibleRange = new NumberRange(minTime, maxTime);
      }
    }
  }
  
  // Reset loading state (for cleanup)
  resetLoadingState(): void {
    this.isLoading = false;
  }
}

// Singleton instance
export const LayoutEngine = new LayoutEngineClass();
