// Chart Engine - Layout-driven multi-pane chart with efficient rendering
// Implements dynamic pane creation, series store, and optimized data updates

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
  EXyDirection,
  SciChartOverview,
  HorizontalLineAnnotation,
  ELabelPlacement,
} from 'scichart';
import { darkChartTheme, lightChartTheme } from '@/lib/chart-theme';
import { SeriesStore } from '@/lib/series-store';
import { IngestQueue } from '@/lib/ingest-queue';
import type { Sample } from '@/lib/wsfeed-client';
import type { PlotLayout, PaneDefinition, HorizontalLine } from '@/types/layout';
import { defaultLayout, matchesSeriesPattern, getSeriesConfig } from '@/types/layout';
import { defaultChartConfig } from '@/types/chart';

interface ChartEngineProps {
  containerId: string;
  layout?: PlotLayout;
  theme?: 'dark' | 'light';
  onFpsUpdate?: (fps: number) => void;
  onDataClockUpdate?: (ms: number) => void;
  onReadyChange?: (ready: boolean) => void;
}

interface PaneSurface {
  id: string;
  surface: SciChartSurface;
  wasmContext: TSciChart;
  renderableSeries: Map<string, FastLineRenderableSeries | FastCandlestickRenderableSeries>;
}

interface ChartEngineState {
  isReady: boolean;
  isLive: boolean;
  dataClockMs: number;
  totalPoints: number;
}

export function useChartEngine({
  containerId,
  layout = defaultLayout,
  theme = 'dark',
  onFpsUpdate,
  onDataClockUpdate,
  onReadyChange,
}: ChartEngineProps) {
  const [state, setState] = useState<ChartEngineState>({
    isReady: false,
    isLive: true,
    dataClockMs: 0,
    totalPoints: 0,
  });

  // Refs for chart objects
  const panesRef = useRef<Map<string, PaneSurface>>(new Map());
  const verticalGroupRef = useRef<SciChartVerticalGroup | null>(null);
  const overviewRef = useRef<SciChartOverview | null>(null);
  const seriesStoreRef = useRef(new SeriesStore());
  const ingestQueueRef = useRef(new IngestQueue({
    maxBatchesPerFrame: 10,
    maxMsPerFrame: 8,
    maxQueueSize: 100000,
    dropPolicy: 'oldest',
  }));

  // Tracking refs
  const fpsCounterRef = useRef({ frameCount: 0, lastTime: performance.now() });
  const isLiveRef = useRef(true);
  const userInteractedRef = useRef(false);
  const lastDataTimeRef = useRef(0);
  const interactionTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Get appropriate theme
  const chartTheme = theme === 'dark' ? darkChartTheme : lightChartTheme;

  // Initialize charts based on layout
  useEffect(() => {
    let isMounted = true;
    const panes = panesRef.current;

    const initCharts = async () => {
      try {
        SciChartSurface.useWasmFromCDN();

        // Create vertical group for X-axis linking
        const verticalGroup = new SciChartVerticalGroup();
        verticalGroupRef.current = verticalGroup;

        // Create pane for each definition in layout
        let primaryWasm: TSciChart | null = null;

        for (let i = 0; i < layout.panes.length; i++) {
          const paneConfig = layout.panes[i];
          const paneContainerId = `${containerId}-pane-${paneConfig.id}`;

          // Check if container exists, if not skip
          const container = document.getElementById(paneContainerId);
          if (!container) continue;

          const result = await SciChartSurface.create(paneContainerId, { theme: chartTheme });
          if (!isMounted) {
            result.sciChartSurface.delete();
            return;
          }

          const { sciChartSurface: surface, wasmContext: wasm } = result;

          // Store primary WASM context for series store
          if (!primaryWasm) {
            primaryWasm = wasm;
            seriesStoreRef.current.setWasmContext(wasm);
          }

          // Configure axes
          const isLastPane = i === layout.panes.length - 1;
          const xAxis = new DateTimeNumericAxis(wasm, {
            axisTitle: '',
            autoRange: EAutoRange.Once,
            drawMajorGridLines: true,
            drawMinorGridLines: false,
            isVisible: isLastPane, // Only show X-axis on bottom pane
          });

          const yAxis = new NumericAxis(wasm, {
            axisTitle: paneConfig.title || '',
            autoRange: EAutoRange.Always,
            drawMajorGridLines: true,
            drawMinorGridLines: false,
            axisAlignment: EAxisAlignment.Right,
          });

          surface.xAxes.add(xAxis);
          surface.yAxes.add(yAxis);

          // Add modifiers
          surface.chartModifiers.add(
            new ZoomPanModifier({ xyDirection: EXyDirection.XDirection }),
            new ZoomExtentsModifier(),
            new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection }),
            new RubberBandXyZoomModifier({ xyDirection: EXyDirection.XDirection, isAnimated: true }),
            new XAxisDragModifier(),
            new YAxisDragModifier(),
            new CursorModifier({
              showXLine: true,
              showYLine: true,
              showTooltip: false,
            }),
          );

          // Add horizontal line overlays
          if (paneConfig.overlays?.hline) {
            for (const hline of paneConfig.overlays.hline) {
              addHorizontalLineAnnotation(surface, hline);
            }
          }

          // Link to vertical group
          verticalGroup.addSurfaceToGroup(surface);

          // Store pane surface
          const paneSurface: PaneSurface = {
            id: paneConfig.id,
            surface,
            wasmContext: wasm,
            renderableSeries: new Map(),
          };
          panes.set(paneConfig.id, paneSurface);

          // FPS tracking on first pane
          if (i === 0) {
            surface.rendered.subscribe(() => {
              fpsCounterRef.current.frameCount++;
              const now = performance.now();
              const elapsed = now - fpsCounterRef.current.lastTime;
              if (elapsed >= 1000) {
                const fps = Math.round((fpsCounterRef.current.frameCount * 1000) / elapsed);
                fpsCounterRef.current.frameCount = 0;
                fpsCounterRef.current.lastTime = now;
                onFpsUpdate?.(fps);
              }
            });
          }

          // User interaction detection
          const markInteracted = () => {
            userInteractedRef.current = true;
            isLiveRef.current = false;
            setState(prev => ({ ...prev, isLive: false }));
            if (interactionTimeoutRef.current) {
              clearTimeout(interactionTimeoutRef.current);
            }
            interactionTimeoutRef.current = setTimeout(() => {
              userInteractedRef.current = false;
            }, 10000);
          };

          if (surface.domCanvas2D) {
            ['mousedown', 'wheel', 'touchstart'].forEach(evt => {
              surface.domCanvas2D?.addEventListener(evt, markInteracted, { passive: true });
            });
          }
        }

        // Start ingest queue drain loop
        ingestQueueRef.current.start((samples) => {
          processSamples(samples);
        });

        setState(prev => ({ ...prev, isReady: true }));
        onReadyChange?.(true);

      } catch (error) {
        console.error('ChartEngine initialization error:', error);
      }
    };

    initCharts();

    return () => {
      isMounted = false;
      ingestQueueRef.current.stop();
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      // Cleanup surfaces
      for (const pane of panes.values()) {
        pane.surface.delete();
      }
      panes.clear();
      overviewRef.current?.delete();
      seriesStoreRef.current.dispose();
    };
  }, [containerId, layout.panes.length]); // Re-init if pane count changes

  // Add horizontal line annotation helper
  const addHorizontalLineAnnotation = (surface: SciChartSurface, config: HorizontalLine) => {
    const annotation = new HorizontalLineAnnotation({
      y1: config.y,
      stroke: config.color || '#888888',
      strokeThickness: config.style?.strokeThickness || 1,
      strokeDashArray: config.style?.strokeDashArray,
      labelPlacement: ELabelPlacement.TopLeft,
      labelValue: config.label,
      showLabel: !!config.label,
    });
    surface.annotations.add(annotation);
  };

  // Process samples - called by drain loop
  const processSamples = useCallback((samples: Sample[]) => {
    const panes = panesRef.current;
    const seriesStore = seriesStoreRef.current;

    if (panes.size === 0 || samples.length === 0) return;

    // Group samples by series type for batch processing
    const tickBatches: Map<string, { x: number[]; y: number[] }> = new Map();
    const smaBatches: Map<string, { x: number[]; y: number[] }> = new Map();
    const ohlcBatches: Map<string, { x: number[]; o: number[]; h: number[]; l: number[]; c: number[] }> = new Map();

    let latestTime = lastDataTimeRef.current;

    for (const sample of samples) {
      const { series_id, t_ms, payload } = sample;

      if (t_ms > latestTime) latestTime = t_ms;

      // Route based on series_id pattern
      if (series_id.includes(':ticks') && typeof payload.price === 'number') {
        if (!tickBatches.has(series_id)) {
          tickBatches.set(series_id, { x: [], y: [] });
        }
        const batch = tickBatches.get(series_id)!;
        batch.x.push(t_ms);
        batch.y.push(payload.price as number);
      } else if (series_id.includes(':sma_') && typeof payload.value === 'number') {
        if (!smaBatches.has(series_id)) {
          smaBatches.set(series_id, { x: [], y: [] });
        }
        const batch = smaBatches.get(series_id)!;
        batch.x.push(t_ms);
        batch.y.push(payload.value as number);
      } else if (series_id.includes(':ohlc_time:')) {
        const { o, h, l, c } = payload as { o: number; h: number; l: number; c: number };
        if (typeof o === 'number' && typeof h === 'number' && typeof l === 'number' && typeof c === 'number') {
          if (!ohlcBatches.has(series_id)) {
            ohlcBatches.set(series_id, { x: [], o: [], h: [], l: [], c: [] });
          }
          const batch = ohlcBatches.get(series_id)!;
          batch.x.push(t_ms);
          batch.o.push(o);
          batch.h.push(h);
          batch.l.push(l);
          batch.c.push(c);
        }
      }
    }

    lastDataTimeRef.current = latestTime;
    onDataClockUpdate?.(latestTime);

    // Suspend updates on all surfaces
    for (const pane of panes.values()) {
      pane.surface.suspendUpdates();
    }

    try {
      // Append tick data
      for (const [seriesId, batch] of tickBatches) {
        const paneId = findPaneForSeries(seriesId);
        const pane = paneId ? panes.get(paneId) : panes.values().next().value;
        if (!pane) continue;

        let dataSeries = seriesStore.getXySeries(seriesId);
        if (!dataSeries) {
          // Create series with pane's WASM context
          dataSeries = new XyDataSeries(pane.wasmContext, {
            dataSeriesName: seriesId,
            fifoCapacity: defaultChartConfig.performance.maxTickPoints,
            containsNaN: false,
            isSorted: true,
          });
        }

        // Ensure renderable series exists
        if (!pane.renderableSeries.has(seriesId)) {
          const config = getSeriesConfig(layout, seriesId);
          const lineSeries = new FastLineRenderableSeries(pane.wasmContext, {
            dataSeries,
            stroke: config?.color || '#50C7E0',
            strokeThickness: config?.strokeThickness || 1,
          });
          pane.surface.renderableSeries.add(lineSeries);
          pane.renderableSeries.set(seriesId, lineSeries);
        }

        // Append data
        dataSeries.appendRange(
          Float64Array.from(batch.x),
          Float64Array.from(batch.y)
        );
        seriesStore.updateSeriesStats(seriesId, batch.x.length, batch.x[batch.x.length - 1]);
      }

      // Append SMA data
      for (const [seriesId, batch] of smaBatches) {
        const paneId = findPaneForSeries(seriesId);
        const pane = paneId ? panes.get(paneId) : panes.values().next().value;
        if (!pane) continue;

        let dataSeries = seriesStore.getXySeries(seriesId);
        if (!dataSeries) {
          dataSeries = new XyDataSeries(pane.wasmContext, {
            dataSeriesName: seriesId,
            fifoCapacity: defaultChartConfig.performance.maxSmaPoints,
            containsNaN: false,
            isSorted: true,
          });
        }

        // Ensure renderable series exists
        if (!pane.renderableSeries.has(seriesId)) {
          const config = getSeriesConfig(layout, seriesId);
          const lineSeries = new FastLineRenderableSeries(pane.wasmContext, {
            dataSeries,
            stroke: config?.color || '#F48420',
            strokeThickness: config?.strokeThickness || 2,
          });
          pane.surface.renderableSeries.add(lineSeries);
          pane.renderableSeries.set(seriesId, lineSeries);
        }

        dataSeries.appendRange(
          Float64Array.from(batch.x),
          Float64Array.from(batch.y)
        );
        seriesStore.updateSeriesStats(seriesId, batch.x.length, batch.x[batch.x.length - 1]);
      }

      // Append OHLC data
      for (const [seriesId, batch] of ohlcBatches) {
        const paneId = findPaneForSeries(seriesId);
        const pane = paneId ? panes.get(paneId) : Array.from(panes.values())[1] || panes.values().next().value;
        if (!pane) continue;

        let dataSeries = seriesStore.getOhlcSeries(seriesId);
        if (!dataSeries) {
          dataSeries = new OhlcDataSeries(pane.wasmContext, {
            dataSeriesName: seriesId,
            fifoCapacity: defaultChartConfig.performance.maxBarPoints,
            containsNaN: false,
          });
        }

        // Ensure renderable series exists
        if (!pane.renderableSeries.has(seriesId)) {
          const candleSeries = new FastCandlestickRenderableSeries(pane.wasmContext, {
            dataSeries,
            strokeUp: '#26a69a',
            brushUp: '#26a69a88',
            strokeDown: '#ef5350',
            brushDown: '#ef535088',
            strokeThickness: 1,
          });
          pane.surface.renderableSeries.add(candleSeries);
          pane.renderableSeries.set(seriesId, candleSeries);
        }

        dataSeries.appendRange(
          Float64Array.from(batch.x),
          Float64Array.from(batch.o),
          Float64Array.from(batch.h),
          Float64Array.from(batch.l),
          Float64Array.from(batch.c)
        );
        seriesStore.updateSeriesStats(seriesId, batch.x.length, batch.x[batch.x.length - 1]);
      }

    } finally {
      // Resume updates on all surfaces
      for (const pane of panes.values()) {
        pane.surface.resumeUpdates();
      }
    }

    // Auto-scroll in live mode
    if (isLiveRef.current && !userInteractedRef.current && latestTime > 0) {
      const windowMs = 5 * 60 * 1000;
      const newRange = new NumberRange(latestTime - windowMs, latestTime + windowMs * 0.05);
      
      for (const pane of panes.values()) {
        const xAxis = pane.surface.xAxes.get(0);
        if (xAxis) xAxis.visibleRange = newRange;
      }
    }

    // Update state
    setState(prev => ({
      ...prev,
      dataClockMs: latestTime,
      totalPoints: seriesStore.getTotalPointCount(),
    }));
  }, [layout, onDataClockUpdate]);

  // Find pane for series based on layout
  const findPaneForSeries = (seriesId: string): string | null => {
    for (const assignment of layout.series) {
      if (matchesSeriesPattern(seriesId, assignment.series_id)) {
        return assignment.pane;
      }
    }
    // Default routing
    if (seriesId.includes(':ohlc_time:')) {
      return layout.panes.find(p => p.id.includes('ohlc'))?.id || null;
    }
    return layout.panes[0]?.id || null;
  };

  // Public API: Enqueue samples (called by WebSocket handler)
  const enqueueSamples = useCallback((samples: Sample[]) => {
    ingestQueueRef.current.enqueue(samples);
  }, []);

  // Public API: Set live mode
  const setLiveMode = useCallback((live: boolean) => {
    isLiveRef.current = live;
    setState(prev => ({ ...prev, isLive: live }));
  }, []);

  // Public API: Zoom to extents
  const zoomExtents = useCallback(() => {
    for (const pane of panesRef.current.values()) {
      pane.surface.zoomExtents();
    }
  }, []);

  // Public API: Jump to live
  const jumpToLive = useCallback(() => {
    isLiveRef.current = true;
    userInteractedRef.current = false;
    setState(prev => ({ ...prev, isLive: true }));

    const lastTime = lastDataTimeRef.current;
    if (lastTime > 0) {
      const windowMs = 5 * 60 * 1000;
      const newRange = new NumberRange(lastTime - windowMs, lastTime + windowMs * 0.05);
      
      for (const pane of panesRef.current.values()) {
        const xAxis = pane.surface.xAxes.get(0);
        if (xAxis) xAxis.visibleRange = newRange;
      }
    }
  }, []);

  // Public API: Get ingest queue stats
  const getIngestStats = useCallback(() => {
    return ingestQueueRef.current.getStats();
  }, []);

  return {
    state,
    enqueueSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
    getIngestStats,
    panesRef,
  };
}
