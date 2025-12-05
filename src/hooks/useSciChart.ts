import { useEffect, useRef, useState, useCallback } from 'react';
import {
  SciChartSurface,
  NumericAxis,
  DateTimeNumericAxis,
  FastLineRenderableSeries,
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
} from 'scichart';
import { defaultChartConfig, ChartConfig } from '@/types/chart';
import type { Sample } from '@/lib/wsfeed-client';

interface UseSciChartOptions {
  containerId: string;
  config?: Partial<ChartConfig>;
}

interface ChartRefs {
  surface: SciChartSurface | null;
  wasmContext: TSciChart | null;
  tickDataSeries: XyDataSeries | null;
  smaDataSeries: Map<string, XyDataSeries>;
  ohlcDataSeries: OhlcDataSeries | null;
}

interface ChartState {
  isReady: boolean;
  fps: number;
  dataClockMs: number;
  isLive: boolean;
  tickCount: number;
}

export function useSciChart({ containerId, config = {} }: UseSciChartOptions) {
  const chartConfig = { ...defaultChartConfig, ...config };
  const chartRefs = useRef<ChartRefs>({
    surface: null,
    wasmContext: null,
    tickDataSeries: null,
    smaDataSeries: new Map(),
    ohlcDataSeries: null,
  });
  
  const [state, setState] = useState<ChartState>({
    isReady: false,
    fps: 0,
    dataClockMs: 0,
    isLive: true,
    tickCount: 0,
  });

  const fpsCounter = useRef({ frameCount: 0, lastTime: performance.now() });
  const isLiveRef = useRef(true);
  const userInteractedRef = useRef(false);
  const lastDataTimeRef = useRef(0);

  // Initialize SciChart
  useEffect(() => {
    let isMounted = true;

    const initChart = async () => {
      try {
        // Configure SciChart WASM
        SciChartSurface.useWasmFromCDN();

        const container = document.getElementById(containerId);
        if (!container) return;

        // Create main surface
        const { sciChartSurface, wasmContext } = await SciChartSurface.create(containerId, {
          theme: {
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
          }
        });

        if (!isMounted) {
          sciChartSurface.delete();
          return;
        }

        // Configure axes
        const xAxis = new DateTimeNumericAxis(wasmContext, {
          axisTitle: 'Time',
          autoRange: EAutoRange.Once,
          drawMajorGridLines: true,
          drawMinorGridLines: true,
        });

        const yAxis = new NumericAxis(wasmContext, {
          axisTitle: 'Price',
          autoRange: EAutoRange.Always,
          drawMajorGridLines: true,
          drawMinorGridLines: false,
        });

        sciChartSurface.xAxes.add(xAxis);
        sciChartSurface.yAxes.add(yAxis);

        // Create data series with FIFO for performance
        const tickDataSeries = new XyDataSeries(wasmContext, {
          dataSeriesName: 'Ticks',
          fifoCapacity: chartConfig.performance.fifoEnabled 
            ? chartConfig.performance.maxTickPoints 
            : undefined,
          containsNaN: false,
          isSorted: true,
        });

        const ohlcDataSeries = new OhlcDataSeries(wasmContext, {
          dataSeriesName: 'OHLC',
          fifoCapacity: chartConfig.performance.fifoEnabled 
            ? chartConfig.performance.maxBarPoints 
            : undefined,
          containsNaN: false,
        });

        // Create renderable series
        const tickLineSeries = new FastLineRenderableSeries(wasmContext, {
          dataSeries: tickDataSeries,
          stroke: '#50C7E0',
          strokeThickness: 1,
        });

        sciChartSurface.renderableSeries.add(tickLineSeries);

        // Add chart modifiers for interaction
        sciChartSurface.chartModifiers.add(
          new ZoomPanModifier({ enableZoom: true }),
          new ZoomExtentsModifier(),
          new MouseWheelZoomModifier(),
          new RubberBandXyZoomModifier({ isAnimated: true }),
          new XAxisDragModifier(),
          new YAxisDragModifier(),
        );

        // FPS tracking
        const updateFps = () => {
          fpsCounter.current.frameCount++;
          const now = performance.now();
          const elapsed = now - fpsCounter.current.lastTime;
          if (elapsed >= 1000) {
            const fps = Math.round((fpsCounter.current.frameCount * 1000) / elapsed);
            fpsCounter.current.frameCount = 0;
            fpsCounter.current.lastTime = now;
            if (isMounted) {
              setState(prev => ({ ...prev, fps }));
            }
          }
        };
        sciChartSurface.rendered.subscribe(updateFps);

        // User interaction detection for auto-scroll
        const markInteracted = () => {
          userInteractedRef.current = true;
          setTimeout(() => {
            userInteractedRef.current = false;
          }, 10000);
        };

        const canvas = sciChartSurface.domCanvas2D;
        if (canvas) {
          ['mousedown', 'wheel', 'touchstart'].forEach(evt => {
            canvas.addEventListener(evt, markInteracted, { passive: true });
          });
        }

        // Store references
        chartRefs.current = {
          surface: sciChartSurface,
          wasmContext,
          tickDataSeries,
          smaDataSeries: new Map(),
          ohlcDataSeries,
        };

        setState(prev => ({ ...prev, isReady: true }));

      } catch (error) {
        console.error('SciChart initialization error:', error);
      }
    };

    initChart();

    return () => {
      isMounted = false;
      if (chartRefs.current.surface) {
        chartRefs.current.surface.delete();
      }
    };
  }, [containerId]);

  // Append samples to chart
  const appendSamples = useCallback((samples: Sample[]) => {
    const { surface, wasmContext, tickDataSeries, smaDataSeries, ohlcDataSeries } = chartRefs.current;
    if (!surface || !tickDataSeries || !wasmContext) return;

    const tickX: number[] = [];
    const tickY: number[] = [];
    const ohlcX: number[] = [];
    const ohlcO: number[] = [];
    const ohlcH: number[] = [];
    const ohlcL: number[] = [];
    const ohlcC: number[] = [];
    const smaBuffers: Map<string, { x: number[]; y: number[] }> = new Map();

    let latestTime = lastDataTimeRef.current;
    let newTickCount = 0;

    for (const sample of samples) {
      const { series_id, t_ms, payload } = sample;
      
      if (t_ms > latestTime) {
        latestTime = t_ms;
      }

      // Tick data
      if (series_id.includes(':ticks') && typeof payload.price === 'number') {
        tickX.push(t_ms);
        tickY.push(payload.price as number);
        newTickCount++;
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
      if (series_id.includes(':ohlc_time:') && ohlcDataSeries) {
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

    // Batch append with suspendUpdates for performance
    surface.suspendUpdates();
    try {
      if (tickX.length > 0) {
        tickDataSeries.appendRange(
          Float64Array.from(tickX),
          Float64Array.from(tickY)
        );
      }

      // Append SMA data
      for (const [smaId, buf] of smaBuffers) {
        let smaSeries = smaDataSeries.get(smaId);
        if (!smaSeries) {
          // Create new SMA series dynamically
          smaSeries = new XyDataSeries(wasmContext, {
            dataSeriesName: smaId.toUpperCase(),
            fifoCapacity: chartConfig.performance.maxSmaPoints,
            containsNaN: false,
            isSorted: true,
          });
          smaDataSeries.set(smaId, smaSeries);

          // Add renderable series
          const smaLineSeries = new FastLineRenderableSeries(wasmContext, {
            dataSeries: smaSeries,
            stroke: '#F48420',
            strokeThickness: 2,
          });
          surface.renderableSeries.add(smaLineSeries);
        }

        if (smaSeries && buf.x.length > 0) {
          smaSeries.appendRange(
            Float64Array.from(buf.x),
            Float64Array.from(buf.y)
          );
        }
      }

      // Append OHLC data
      if (ohlcDataSeries && ohlcX.length > 0) {
        ohlcDataSeries.appendRange(
          Float64Array.from(ohlcX),
          Float64Array.from(ohlcO),
          Float64Array.from(ohlcH),
          Float64Array.from(ohlcL),
          Float64Array.from(ohlcC)
        );
      }
    } finally {
      surface.resumeUpdates();
    }

    // Auto-scroll in live mode
    if (isLiveRef.current && !userInteractedRef.current && latestTime > 0) {
      const windowMs = 5 * 60 * 1000; // 5 minutes
      const xAxis = surface.xAxes.get(0);
      if (xAxis) {
        xAxis.visibleRange = new NumberRange(latestTime - windowMs, latestTime + windowMs * 0.05);
      }
    }

    // Update state
    setState(prev => ({
      ...prev,
      dataClockMs: latestTime,
      tickCount: prev.tickCount + newTickCount,
    }));
  }, [chartConfig.performance.maxSmaPoints]);

  // Toggle live mode
  const setLiveMode = useCallback((live: boolean) => {
    isLiveRef.current = live;
    setState(prev => ({ ...prev, isLive: live }));
  }, []);

  // Zoom to extents
  const zoomExtents = useCallback(() => {
    chartRefs.current.surface?.zoomExtents();
  }, []);

  // Jump to live
  const jumpToLive = useCallback(() => {
    setLiveMode(true);
    const { surface } = chartRefs.current;
    const lastTime = lastDataTimeRef.current;
    if (surface && lastTime > 0) {
      const windowMs = 5 * 60 * 1000;
      const xAxis = surface.xAxes.get(0);
      if (xAxis) {
        xAxis.visibleRange = new NumberRange(lastTime - windowMs, lastTime + windowMs * 0.05);
      }
    }
  }, [setLiveMode]);

  return {
    state,
    appendSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
    chartRefs,
  };
}
