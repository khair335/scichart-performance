/**
 * Strategy Marker Annotation Renderer
 * Renders strategy entry/exit markers as visual annotations on charts
 */

import {
  CustomAnnotation,
  EHorizontalAnchorPoint,
  EVerticalAnchorPoint,
  ECoordinateMode,
  SciChartSurface,
} from 'scichart';

export interface MarkerData {
  x: number; // Unix timestamp in milliseconds (matches X-axis units)
  y: number; // Price level
  type: 'entry' | 'exit' | 'signal';
  direction?: 'long' | 'short';
  label?: string;
}

// SVG templates for different marker types
const MARKER_SVGS = {
  entryLong: `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <polygon points="8,2 14,14 2,14" fill="#4CAF50" stroke="#2E7D32" stroke-width="1"/>
    </svg>
  `,
  entryShort: `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <polygon points="8,14 14,2 2,2" fill="#F44336" stroke="#C62828" stroke-width="1"/>
    </svg>
  `,
  exitLong: `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <polygon points="8,2 14,14 2,14" fill="none" stroke="#4CAF50" stroke-width="2"/>
    </svg>
  `,
  exitShort: `
    <svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
      <polygon points="8,14 14,2 2,2" fill="none" stroke="#F44336" stroke-width="2"/>
    </svg>
  `,
  signal: `
    <svg width="12" height="12" viewBox="0 0 12 12" xmlns="http://www.w3.org/2000/svg">
      <circle cx="6" cy="6" r="5" fill="#FF9800" stroke="#E65100" stroke-width="1"/>
    </svg>
  `,
};

/**
 * Create an SVG annotation for a strategy marker
 */
export function createMarkerAnnotation(
  marker: MarkerData,
  wasm: any
): CustomAnnotation {
  // Select appropriate SVG based on marker type and direction
  let svgString: string;
  if (marker.type === 'signal') {
    svgString = MARKER_SVGS.signal;
  } else if (marker.type === 'entry') {
    svgString = marker.direction === 'short' ? MARKER_SVGS.entryShort : MARKER_SVGS.entryLong;
  } else {
    svgString = marker.direction === 'short' ? MARKER_SVGS.exitShort : MARKER_SVGS.exitLong;
  }

  // Create the annotation
  const annotation = new CustomAnnotation({
    x1: marker.x,
    y1: marker.y,
    horizontalAnchorPoint: EHorizontalAnchorPoint.Center,
    verticalAnchorPoint: marker.type === 'entry' 
      ? (marker.direction === 'short' ? EVerticalAnchorPoint.Top : EVerticalAnchorPoint.Bottom)
      : (marker.direction === 'short' ? EVerticalAnchorPoint.Bottom : EVerticalAnchorPoint.Top),
    svgString,
  });

  return annotation;
}

/**
 * Parse marker data from a sample
 * Server binary format sends: { strategy, side, tag, price, qty }
 * Server may also send: { type, direction, label } for JSON format
 */
export function parseMarkerFromSample(sample: {
  t_ms: number;
  v: number;
  // Binary format fields
  side?: string;
  tag?: string;
  // JSON format fields (alternative)
  type?: string;
  direction?: string;
  label?: string;
}, seriesId?: string): MarkerData {
  // Determine marker type from tag field (binary) or type field (JSON) or series_id
  let markerType: 'entry' | 'exit' | 'signal' = 'signal';
  
  // Check tag field first (binary format: "entry", "exit", etc.)
  const tag = sample.tag?.toLowerCase() || sample.type?.toLowerCase() || '';
  if (tag.includes('entry') || tag === 'buy' || tag === 'open') {
    markerType = 'entry';
  } else if (tag.includes('exit') || tag === 'sell' || tag === 'close') {
    markerType = 'exit';
  } else if (seriesId?.includes(':signals')) {
    markerType = 'signal';
  } else if (seriesId?.includes(':markers')) {
    // Markers without explicit type default to entry
    markerType = 'entry';
  }

  // Determine direction from side field (binary: "long"/"short") or direction field (JSON)
  let direction: 'long' | 'short' | undefined;
  const side = sample.side || sample.direction;
  if (side === 'long' || side === 'L' || tag.includes('long')) {
    direction = 'long';
  } else if (side === 'short' || side === 'S' || tag.includes('short')) {
    direction = 'short';
  }

  return {
    x: sample.t_ms / 1000, // Convert to Unix seconds to match DateTimeNumericAxis (which uses seconds, not milliseconds)
    y: sample.v,
    type: markerType,
    direction,
    label: sample.tag || sample.label,
  };
}

/**
 * Batch add annotations to a surface
 * Uses suspendUpdates for performance
 */
export function addMarkersToSurface(
  surface: SciChartSurface,
  markers: MarkerData[],
  wasm: any
): void {
  if (markers.length === 0) return;

  surface.suspendUpdates();
  try {
    for (const marker of markers) {
      const annotation = createMarkerAnnotation(marker, wasm);
      surface.annotations.add(annotation);
    }
  } finally {
    surface.resumeUpdates();
  }
}

/**
 * Clear all strategy marker annotations from a surface
 */
export function clearMarkerAnnotations(surface: SciChartSurface): void {
  // Remove all CustomAnnotations (strategy markers)
  const toRemove: CustomAnnotation[] = [];
  for (let i = 0; i < surface.annotations.size(); i++) {
    const annotation = surface.annotations.get(i);
    if (annotation instanceof CustomAnnotation) {
      toRemove.push(annotation);
    }
  }
  
  for (const annotation of toRemove) {
    surface.annotations.remove(annotation);
  }
}

/**
 * Annotation pool for reuse (performance optimization)
 */
export class MarkerAnnotationPool {
  private pool: CustomAnnotation[] = [];
  private activeAnnotations: Map<string, CustomAnnotation> = new Map();

  /**
   * Get or create an annotation for a marker
   */
  getAnnotation(marker: MarkerData, key: string, wasm: any): CustomAnnotation {
    // Check if we have an existing annotation for this key
    const existing = this.activeAnnotations.get(key);
    if (existing) {
      // Update position
      existing.x1 = marker.x;
      existing.y1 = marker.y;
      return existing;
    }

    // Try to reuse from pool
    let annotation = this.pool.pop();
    if (annotation) {
      annotation.x1 = marker.x;
      annotation.y1 = marker.y;
    } else {
      annotation = createMarkerAnnotation(marker, wasm);
    }

    this.activeAnnotations.set(key, annotation);
    return annotation;
  }

  /**
   * Release an annotation back to the pool
   */
  release(key: string): void {
    const annotation = this.activeAnnotations.get(key);
    if (annotation) {
      this.activeAnnotations.delete(key);
      this.pool.push(annotation);
    }
  }

  /**
   * Clear all annotations
   */
  clear(): void {
    this.activeAnnotations.clear();
    this.pool = [];
  }

  /**
   * Get all active annotations
   */
  getActiveAnnotations(): CustomAnnotation[] {
    return Array.from(this.activeAnnotations.values());
  }
}
