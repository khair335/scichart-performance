/**
 * Strategy Marker Scatter Series Manager
 * Renders strategy markers as efficient XyScatterRenderableSeries with appendRange batching
 */

import {
  XyDataSeries,
  XyScatterRenderableSeries,
  EllipsePointMarker,
  TrianglePointMarker,
  SquarePointMarker,
  CrossPointMarker,
  TSciChart,
  IPointMarker,
} from 'scichart';
import type { MarkerShape, StrategyMarkerStyle } from '@/types/plot-layout';

// 5 marker types - one scatter series per type per pane
export type MarkerSeriesType = 'entryLong' | 'entryShort' | 'exitLong' | 'exitShort' | 'signal';

export interface MarkerScatterGroup {
  type: MarkerSeriesType;
  dataSeries: XyDataSeries;
  renderableSeries: XyScatterRenderableSeries;
}

// Default marker styling configuration
const DEFAULT_MARKER_STYLES: Record<MarkerSeriesType, { fill: string; stroke: string; size: number; shape: MarkerShape }> = {
  entryLong: { fill: '#4CAF50', stroke: '#2E7D32', size: 12, shape: 'triangle-up' },
  entryShort: { fill: '#F44336', stroke: '#C62828', size: 12, shape: 'triangle-down' },
  exitLong: { fill: 'transparent', stroke: '#4CAF50', size: 12, shape: 'circle' },
  exitShort: { fill: 'transparent', stroke: '#F44336', size: 12, shape: 'circle' },
  signal: { fill: '#FF9800', stroke: '#E65100', size: 10, shape: 'circle' },
};

/**
 * Create a point marker based on shape type
 */
export function createPointMarker(
  wasmContext: TSciChart,
  shape: MarkerShape,
  options: { width: number; height: number; fill: string; stroke: string; strokeThickness: number }
): IPointMarker {
  switch (shape) {
    case 'triangle-up':
      return new TrianglePointMarker(wasmContext, options);
    case 'triangle-down':
      // SciChart doesn't have a built-in down triangle, so we use a rotated approach
      // For now, use square as a visual distinction
      return new SquarePointMarker(wasmContext, options);
    case 'square':
      return new SquarePointMarker(wasmContext, options);
    case 'cross':
      return new CrossPointMarker(wasmContext, options);
    case 'x':
      // X is similar to cross but rotated - use cross for now
      return new CrossPointMarker(wasmContext, { ...options, strokeThickness: options.strokeThickness + 1 });
    case 'circle':
    default:
      return new EllipsePointMarker(wasmContext, options);
  }
}

/**
 * Get the shape for a marker type, using custom style or default
 */
export function getMarkerShape(type: MarkerSeriesType, markerStyle?: StrategyMarkerStyle): MarkerShape {
  if (!markerStyle) {
    return DEFAULT_MARKER_STYLES[type].shape;
  }
  
  switch (type) {
    case 'entryLong':
      return markerStyle.entryLongShape ?? DEFAULT_MARKER_STYLES.entryLong.shape;
    case 'entryShort':
      return markerStyle.entryShortShape ?? DEFAULT_MARKER_STYLES.entryShort.shape;
    case 'exitLong':
      return markerStyle.exitLongShape ?? DEFAULT_MARKER_STYLES.exitLong.shape;
    case 'exitShort':
      return markerStyle.exitShortShape ?? DEFAULT_MARKER_STYLES.exitShort.shape;
    case 'signal':
      return markerStyle.signalShape ?? DEFAULT_MARKER_STYLES.signal.shape;
    default:
      return 'circle';
  }
}

/**
 * Get the color for a marker type, using custom style or default
 */
export function getMarkerColor(type: MarkerSeriesType, markerStyle?: StrategyMarkerStyle): { fill: string; stroke: string } {
  const defaults = DEFAULT_MARKER_STYLES[type];
  
  if (!markerStyle) {
    return { fill: defaults.fill, stroke: defaults.stroke };
  }
  
  switch (type) {
    case 'entryLong':
      return {
        fill: markerStyle.entryLongColor ?? defaults.fill,
        stroke: markerStyle.entryLongColor ?? defaults.stroke,
      };
    case 'entryShort':
      return {
        fill: markerStyle.entryShortColor ?? defaults.fill,
        stroke: markerStyle.entryShortColor ?? defaults.stroke,
      };
    case 'exitLong':
      return {
        fill: 'transparent', // exits are always outline-only
        stroke: markerStyle.exitLongColor ?? defaults.stroke,
      };
    case 'exitShort':
      return {
        fill: 'transparent', // exits are always outline-only
        stroke: markerStyle.exitShortColor ?? defaults.stroke,
      };
    case 'signal':
      return {
        fill: markerStyle.signalColor ?? defaults.fill,
        stroke: markerStyle.signalColor ?? defaults.stroke,
      };
    default:
      return { fill: defaults.fill, stroke: defaults.stroke };
  }
}

/**
 * Create a scatter series for a specific marker type with optional custom styling
 */
export function createMarkerScatterSeries(
  wasmContext: TSciChart,
  type: MarkerSeriesType,
  capacity: number,
  paneId: string,
  markerStyle?: StrategyMarkerStyle
): MarkerScatterGroup {
  const defaults = DEFAULT_MARKER_STYLES[type];
  const size = markerStyle?.markerSize ?? defaults.size;
  const shape = getMarkerShape(type, markerStyle);
  const colors = getMarkerColor(type, markerStyle);
  const isExit = type === 'exitLong' || type === 'exitShort';
  
  // Create data series with FIFO for memory management
  const dataSeries = new XyDataSeries(wasmContext, {
    dataSeriesName: `marker_${type}_${paneId}`,
    fifoCapacity: capacity,
    capacity: capacity,
    containsNaN: false,
    dataIsSortedInX: true,
    dataEvenlySpacedInX: false,
  });

  // Create point marker based on shape
  const pointMarker = createPointMarker(wasmContext, shape, {
    width: size,
    height: size,
    fill: colors.fill,
    stroke: colors.stroke,
    strokeThickness: isExit ? 2 : 1,
  });

  // Create scatter renderable series
  const renderableSeries = new XyScatterRenderableSeries(wasmContext, {
    dataSeries,
    pointMarker,
    opacity: 1,
  });

  return {
    type,
    dataSeries,
    renderableSeries,
  };
}

/**
 * Create all 5 marker scatter series for a pane with optional custom styling
 */
export function createAllMarkerScatterSeries(
  wasmContext: TSciChart,
  capacity: number,
  paneId: string,
  markerStyle?: StrategyMarkerStyle
): Map<MarkerSeriesType, MarkerScatterGroup> {
  const groups = new Map<MarkerSeriesType, MarkerScatterGroup>();
  const types: MarkerSeriesType[] = ['entryLong', 'entryShort', 'exitLong', 'exitShort', 'signal'];
  
  for (const type of types) {
    groups.set(type, createMarkerScatterSeries(wasmContext, type, capacity, paneId, markerStyle));
  }
  
  return groups;
}

/**
 * Determine marker series type from parsed marker data
 */
export function getMarkerSeriesType(marker: { type: 'entry' | 'exit' | 'signal'; direction?: 'long' | 'short' }): MarkerSeriesType {
  if (marker.type === 'signal') {
    return 'signal';
  }
  
  if (marker.type === 'entry') {
    return marker.direction === 'short' ? 'entryShort' : 'entryLong';
  }
  
  // exit
  return marker.direction === 'short' ? 'exitShort' : 'exitLong';
}

/**
 * Batch structure for accumulating markers before appendRange
 */
export interface MarkerBatch {
  x: number[];
  y: number[];
}

/**
 * Create empty marker batches for all types
 */
export function createEmptyMarkerBatches(): Map<MarkerSeriesType, MarkerBatch> {
  const batches = new Map<MarkerSeriesType, MarkerBatch>();
  const types: MarkerSeriesType[] = ['entryLong', 'entryShort', 'exitLong', 'exitShort', 'signal'];
  
  for (const type of types) {
    batches.set(type, { x: [], y: [] });
  }
  
  return batches;
}
