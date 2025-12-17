/**
 * Strategy Marker Scatter Series Manager
 * Renders strategy markers as efficient XyScatterRenderableSeries with appendRange batching
 */

import {
  XyDataSeries,
  XyScatterRenderableSeries,
  EllipsePointMarker,
  TrianglePointMarker,
  TSciChart,
} from 'scichart';

// 5 marker types - one scatter series per type per pane
export type MarkerSeriesType = 'entryLong' | 'entryShort' | 'exitLong' | 'exitShort' | 'signal';

export interface MarkerScatterGroup {
  type: MarkerSeriesType;
  dataSeries: XyDataSeries;
  renderableSeries: XyScatterRenderableSeries;
}

// Marker styling configuration
const MARKER_STYLES: Record<MarkerSeriesType, { fill: string; stroke: string; size: number }> = {
  entryLong: { fill: '#4CAF50', stroke: '#2E7D32', size: 12 },
  entryShort: { fill: '#F44336', stroke: '#C62828', size: 12 },
  exitLong: { fill: 'transparent', stroke: '#4CAF50', size: 12 },
  exitShort: { fill: 'transparent', stroke: '#F44336', size: 12 },
  signal: { fill: '#FF9800', stroke: '#E65100', size: 10 },
};

/**
 * Create a scatter series for a specific marker type
 */
export function createMarkerScatterSeries(
  wasmContext: TSciChart,
  type: MarkerSeriesType,
  capacity: number,
  paneId: string
): MarkerScatterGroup {
  const style = MARKER_STYLES[type];
  
  // Create data series with FIFO for memory management
  const dataSeries = new XyDataSeries(wasmContext, {
    dataSeriesName: `marker_${type}_${paneId}`,
    fifoCapacity: capacity,
    capacity: capacity,
    containsNaN: false,
    dataIsSortedInX: true,
    dataEvenlySpacedInX: false,
  });

  // Create point marker based on type
  let pointMarker;
  if (type === 'signal') {
    // Circle for signals
    pointMarker = new EllipsePointMarker(wasmContext, {
      width: style.size,
      height: style.size,
      fill: style.fill,
      stroke: style.stroke,
      strokeThickness: 1,
    });
  } else if (type === 'entryLong' || type === 'exitLong') {
    // Triangle pointing up for long positions
    pointMarker = new TrianglePointMarker(wasmContext, {
      width: style.size,
      height: style.size,
      fill: style.fill,
      stroke: style.stroke,
      strokeThickness: type === 'exitLong' ? 2 : 1,
    });
  } else {
    // Triangle pointing down for short positions (rotated via negative height trick or custom SVG)
    // SciChart's TrianglePointMarker doesn't have rotation, so we use a square marker with custom styling
    // For now, use triangle with different styling to distinguish
    pointMarker = new TrianglePointMarker(wasmContext, {
      width: style.size,
      height: -style.size, // Negative height flips the triangle
      fill: style.fill,
      stroke: style.stroke,
      strokeThickness: type === 'exitShort' ? 2 : 1,
    });
  }

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
 * Create all 5 marker scatter series for a pane
 */
export function createAllMarkerScatterSeries(
  wasmContext: TSciChart,
  capacity: number,
  paneId: string
): Map<MarkerSeriesType, MarkerScatterGroup> {
  const groups = new Map<MarkerSeriesType, MarkerScatterGroup>();
  const types: MarkerSeriesType[] = ['entryLong', 'entryShort', 'exitLong', 'exitShort', 'signal'];
  
  for (const type of types) {
    groups.set(type, createMarkerScatterSeries(wasmContext, type, capacity, paneId));
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
