import { useEffect, useRef } from 'react';
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
} from 'scichart';
import type { Sample } from '@/lib/wsfeed-client';

interface ChartPaneProps {
  id: string;
  title: string;
  className?: string;
}

// Shared data series across components
export interface ChartDataRefs {
  tickDataSeries: XyDataSeries | null;
  smaDataSeries: Map<string, XyDataSeries>;
  ohlcDataSeries: OhlcDataSeries | null;
}

export function ChartPane({ id, title, className = '' }: ChartPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  return (
    <div className={`relative flex-1 min-h-0 border-b border-border last:border-b-0 ${className}`}>
      <div className="pane-title">{title}</div>
      <div 
        id={id} 
        ref={containerRef} 
        className="w-full h-full"
      />
    </div>
  );
}

// Waiting for data overlay component
export function WaitingOverlay({ seriesId }: { seriesId: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center bg-card/80 backdrop-blur-sm z-20">
      <div className="text-center">
        <div className="animate-pulse-subtle mb-2">
          <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto" />
        </div>
        <p className="text-muted-foreground text-sm font-mono">
          Waiting for {seriesId} data...
        </p>
      </div>
    </div>
  );
}
