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
} from 'scichart';
import type { Sample } from '@/lib/wsfeed-client';
import { defaultChartConfig } from '@/types/chart';
import { darkChartTheme } from '@/lib/chart-theme';

interface MultiPaneChartProps {
  tickContainerId: string;
  ohlcContainerId: string;
  overviewContainerId?: string;
  onFpsUpdate?: (fps: number) => void;
  onDataClockUpdate?: (ms: number) => void;
  onReadyChange?: (ready: boolean) => void;
}

interface ChartRefs {
  tickSurface: SciChartSurface | null;
  ohlcSurface: SciChartSurface | null;
  tickWasm: TSciChart | null;
  ohlcWasm: TSciChart | null;
  tickDataSeries: XyDataSeries | null;
  smaDataSeries: Map<string, XyDataSeries>;
  ohlcDataSeries: OhlcDataSeries | null;
  verticalGroup: SciChartVerticalGroup | null;
  overview: SciChartOverview | null;
}

export function useMultiPaneChart({
  tickContainerId,
  ohlcContainerId,
  overviewContainerId,
  onFpsUpdate,
  onDataClockUpdate,
  onReadyChange,
}: MultiPaneChartProps) {
  const chartRefs = useRef<ChartRefs>({
    tickSurface: null,
    ohlcSurface: null,
    tickWasm: null,
    ohlcWasm: null,
    tickDataSeries: null,
    smaDataSeries: new Map(),
    ohlcDataSeries: null,
    verticalGroup: null,
    overview: null,
  });

  const [isReady, setIsReady] = useState(false);
  const fpsCounter = useRef({ frameCount: 0, lastTime: performance.now() });
  const isLiveRef = useRef(true);
  const userInteractedRef = useRef(false);
  const lastDataTimeRef = useRef(0);
  const interactionTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // Use proper SciChart theme
  const chartTheme = darkChartTheme;

  // Initialize charts
  useEffect(() => {
    let isMounted = true;

    const initCharts = async () => {
      try {
        SciChartSurface.useWasmFromCDN();

        // Create tick/line surface
        const tickResult = await SciChartSurface.create(tickContainerId, { theme: chartTheme });
        if (!isMounted) {
          tickResult.sciChartSurface.delete();
          return;
        }

        const { sciChartSurface: tickSurface, wasmContext: tickWasm } = tickResult;

        // Configure tick axes
        const tickXAxis = new DateTimeNumericAxis(tickWasm, {
          axisTitle: '',
          autoRange: EAutoRange.Once,
          drawMajorGridLines: true,
          drawMinorGridLines: false,
          isVisible: false, // Hide X-axis on top pane, show on bottom
        });

        const tickYAxis = new NumericAxis(tickWasm, {
          axisTitle: 'Price',
          autoRange: EAutoRange.Always,
          drawMajorGridLines: true,
          drawMinorGridLines: false,
          axisAlignment: EAxisAlignment.Right,
        });

        tickSurface.xAxes.add(tickXAxis);
        tickSurface.yAxes.add(tickYAxis);

        // Tick data series with FIFO
        const tickDataSeries = new XyDataSeries(tickWasm, {
          dataSeriesName: 'Ticks',
          fifoCapacity: defaultChartConfig.performance.maxTickPoints,
          containsNaN: false,
          isSorted: true,
        });

        // Tick line series
        const tickLineSeries = new FastLineRenderableSeries(tickWasm, {
          dataSeries: tickDataSeries,
          stroke: '#50C7E0',
          strokeThickness: 1,
        });

        tickSurface.renderableSeries.add(tickLineSeries);

        // Create OHLC surface
        const ohlcResult = await SciChartSurface.create(ohlcContainerId, { theme: chartTheme });
        if (!isMounted) {
          tickSurface.delete();
          ohlcResult.sciChartSurface.delete();
          return;
        }

        const { sciChartSurface: ohlcSurface, wasmContext: ohlcWasm } = ohlcResult;

        // Configure OHLC axes
        const ohlcXAxis = new DateTimeNumericAxis(ohlcWasm, {
          axisTitle: 'Time',
          autoRange: EAutoRange.Once,
          drawMajorGridLines: true,
          drawMinorGridLines: false,
        });

        const ohlcYAxis = new NumericAxis(ohlcWasm, {
          axisTitle: 'Price',
          autoRange: EAutoRange.Always,
          drawMajorGridLines: true,
          drawMinorGridLines: false,
          axisAlignment: EAxisAlignment.Right,
        });

        ohlcSurface.xAxes.add(ohlcXAxis);
        ohlcSurface.yAxes.add(ohlcYAxis);

        // OHLC data series
        const ohlcDataSeries = new OhlcDataSeries(ohlcWasm, {
          dataSeriesName: 'OHLC',
          fifoCapacity: defaultChartConfig.performance.maxBarPoints,
          containsNaN: false,
        });

        // Candlestick series
        const candlestickSeries = new FastCandlestickRenderableSeries(ohlcWasm, {
          dataSeries: ohlcDataSeries,
          strokeUp: '#26a69a',
          brushUp: '#26a69a88',
          strokeDown: '#ef5350',
          brushDown: '#ef535088',
          strokeThickness: 1,
        });

        ohlcSurface.renderableSeries.add(candlestickSeries);

        // Add modifiers to both surfaces
        const addModifiers = (surface: SciChartSurface, wasm: TSciChart) => {
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
        };

        addModifiers(tickSurface, tickWasm);
        addModifiers(ohlcSurface, ohlcWasm);

        // Link X-axes with SciChartVerticalGroup
        const verticalGroup = new SciChartVerticalGroup();
        verticalGroup.addSurfaceToGroup(tickSurface);
        verticalGroup.addSurfaceToGroup(ohlcSurface);

        // FPS tracking
        const updateFps = () => {
          fpsCounter.current.frameCount++;
          const now = performance.now();
          const elapsed = now - fpsCounter.current.lastTime;
          if (elapsed >= 1000) {
            const fps = Math.round((fpsCounter.current.frameCount * 1000) / elapsed);
            fpsCounter.current.frameCount = 0;
            fpsCounter.current.lastTime = now;
            onFpsUpdate?.(fps);
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

        // Create overview if container provided
        let overview: SciChartOverview | null = null;
        if (overviewContainerId) {
          try {
            overview = await SciChartOverview.create(tickSurface, overviewContainerId, {
              theme: chartTheme,
            });
          } catch (e) {
            console.warn('Failed to create overview:', e);
          }
        }

        // Store refs
        chartRefs.current = {
          tickSurface,
          ohlcSurface,
          tickWasm,
          ohlcWasm,
          tickDataSeries,
          smaDataSeries: new Map(),
          ohlcDataSeries,
          verticalGroup,
          overview,
        };

        setIsReady(true);
        onReadyChange?.(true);

      } catch (error) {
        console.error('Multi-pane chart initialization error:', error);
      }
    };

    initCharts();

    return () => {
      isMounted = false;
      if (interactionTimeoutRef.current) {
        clearTimeout(interactionTimeoutRef.current);
      }
      chartRefs.current.tickSurface?.delete();
      chartRefs.current.ohlcSurface?.delete();
      chartRefs.current.overview?.delete();
    };
  }, [tickContainerId, ohlcContainerId, overviewContainerId]);

  // Append samples
  const appendSamples = useCallback((samples: Sample[]) => {
    const refs = chartRefs.current;
    if (!refs.tickSurface || !refs.ohlcSurface || !refs.tickDataSeries) return;

    const tickX: number[] = [];
    const tickY: number[] = [];
    const ohlcX: number[] = [];
    const ohlcO: number[] = [];
    const ohlcH: number[] = [];
    const ohlcL: number[] = [];
    const ohlcC: number[] = [];
    const smaBuffers: Map<string, { x: number[]; y: number[] }> = new Map();

    let latestTime = lastDataTimeRef.current;

    for (const sample of samples) {
      const { series_id, t_ms, payload } = sample;
      
      if (t_ms > latestTime) {
        latestTime = t_ms;
      }

      // Tick data
      if (series_id.includes(':ticks') && typeof payload.price === 'number') {
        tickX.push(t_ms);
        tickY.push(payload.price as number);
      }

      // SMA data
      if (series_id.includes(':sma_') && typeof payload.value === 'number') {
        const smaId = series_id.split(':').find(p => p.startsWith('sma_')) || 'sma';
        if (!smaBuffers.has(smaId)) {
          smaBuffers.set(smaId, { x: [], y: [] });
        }
        const buf = smaBuffers.get(smaId)!;
        buf.x.push(t_ms);
        buf.y.push(payload.value as number);
      }

      // OHLC data
      if (series_id.includes(':ohlc_time:') && refs.ohlcDataSeries) {
        const o = payload.o as number;
        const h = payload.h as number;
        const l = payload.l as number;
        const c = payload.c as number;
        if (typeof o === 'number' && typeof h === 'number' && typeof l === 'number' && typeof c === 'number') {
          ohlcX.push(t_ms);
          ohlcO.push(o);
          ohlcH.push(h);
          ohlcL.push(l);
          ohlcC.push(c);
        }
      }
    }

    lastDataTimeRef.current = latestTime;
    onDataClockUpdate?.(latestTime);

    // Batch updates
    refs.tickSurface.suspendUpdates();
    refs.ohlcSurface.suspendUpdates();

    try {
      // Append tick data
      if (tickX.length > 0) {
        refs.tickDataSeries.appendRange(
          Float64Array.from(tickX),
          Float64Array.from(tickY)
        );
      }

      // Append SMA data
      for (const [smaId, buf] of smaBuffers) {
        let smaSeries = refs.smaDataSeries.get(smaId);
        if (!smaSeries && refs.tickWasm) {
          smaSeries = new XyDataSeries(refs.tickWasm, {
            dataSeriesName: smaId.toUpperCase(),
            fifoCapacity: defaultChartConfig.performance.maxSmaPoints,
            containsNaN: false,
            isSorted: true,
          });
          refs.smaDataSeries.set(smaId, smaSeries);

          // Add to tick surface
          const smaLineSeries = new FastLineRenderableSeries(refs.tickWasm, {
            dataSeries: smaSeries,
            stroke: '#F48420',
            strokeThickness: 2,
          });
          refs.tickSurface?.renderableSeries.add(smaLineSeries);
        }

        if (smaSeries && buf.x.length > 0) {
          smaSeries.appendRange(
            Float64Array.from(buf.x),
            Float64Array.from(buf.y)
          );
        }
      }

      // Append OHLC data
      if (refs.ohlcDataSeries && ohlcX.length > 0) {
        refs.ohlcDataSeries.appendRange(
          Float64Array.from(ohlcX),
          Float64Array.from(ohlcO),
          Float64Array.from(ohlcH),
          Float64Array.from(ohlcL),
          Float64Array.from(ohlcC)
        );
      }
    } finally {
      refs.tickSurface.resumeUpdates();
      refs.ohlcSurface.resumeUpdates();
    }

    // Auto-scroll in live mode
    if (isLiveRef.current && !userInteractedRef.current && latestTime > 0) {
      const windowMs = 5 * 60 * 1000;
      const tickXAxis = refs.tickSurface.xAxes.get(0);
      const ohlcXAxis = refs.ohlcSurface.xAxes.get(0);
      const newRange = new NumberRange(latestTime - windowMs, latestTime + windowMs * 0.05);
      
      if (tickXAxis) tickXAxis.visibleRange = newRange;
      if (ohlcXAxis) ohlcXAxis.visibleRange = newRange;
    }
  }, [onDataClockUpdate]);

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
