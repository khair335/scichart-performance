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
      markers: new Map(),
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
    let foundInPane = false;
    
    for (const pane of this.state.panes.values()) {
      if (pane.isDeleted) continue;
      
      const dataSeries = pane.dataSeries.get(seriesId);
      if (!dataSeries) continue;
      
      foundInPane = true;
      const data = SeriesStore.getLinearizedData(seriesId);
      if (!data || data.x.length === 0) {
        continue;
      }
      
      // Get current count in chart
      const currentCount = dataSeries.count();
      const newCount = data.x.length;
      
      // With FIFO mode, the chart auto-discards old data when full.
      // We need to track what we've already sent, not what's in the chart.
      // Since SeriesStore uses a circular buffer that overwrites old data,
      // we should always try to append the latest data.
      
      // For simplicity: if store has more data than chart, append the difference
      // But cap at what the chart can hold
      
      if (newCount <= currentCount) continue;
      
      // Calculate how many new points to append
      const newDataCount = newCount - currentCount;
      
      // With FIFO, we can always append - the chart will discard old data
      // But we should batch to avoid overwhelming the chart
      const maxBatchSize = Math.min(10000, CHART_FIFO_CAPACITY);
      const appendCount = Math.min(newDataCount, maxBatchSize);
      
      if (appendCount <= 0) continue;
      
      // Start from the appropriate index
      const startIdx = newCount - appendCount;
      
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
