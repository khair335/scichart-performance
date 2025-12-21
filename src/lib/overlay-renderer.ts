/**
 * Overlay Renderer
 * Handles rendering of horizontal and vertical line overlays on chart panes
 * Uses SciChart Annotations for proper fixed-position overlay lines
 */

import {
  SciChartSurface,
  HorizontalLineAnnotation,
  VerticalLineAnnotation,
  ELabelPlacement,
  NumberRange,
} from 'scichart';
import type { HLineConfig, VLineConfig } from '@/types/plot-layout';

// Store overlay annotation references for cleanup
const overlayAnnotationsMap = new Map<string, (HorizontalLineAnnotation | VerticalLineAnnotation)[]>();

// Store hline Y values per pane for Y-axis auto-fit
const hlineYValuesMap = new Map<string, number[]>();

/**
 * Get all hline Y values for a pane (used for Y-axis auto-fit)
 */
export function getHLineYValues(paneId: string): number[] {
  return hlineYValuesMap.get(paneId) || [];
}

/**
 * Calculate Y-axis range that includes both data range and hline values
 * @param dataMin - Minimum Y value from data
 * @param dataMax - Maximum Y value from data
 * @param paneId - Pane ID to get hlines for
 * @param padding - Padding percentage (default 0.1 = 10%)
 * @returns NumberRange that includes data and hlines with padding
 */
export function calculateYRangeWithHLines(
  dataMin: number,
  dataMax: number,
  paneId: string,
  padding: number = 0.1
): NumberRange {
  const hlineYs = getHLineYValues(paneId);
  
  // Start with data range
  let rangeMin = dataMin;
  let rangeMax = dataMax;
  
  // Expand to include all hline Y values
  for (const y of hlineYs) {
    if (y < rangeMin) rangeMin = y;
    if (y > rangeMax) rangeMax = y;
  }
  
  // Apply padding
  const range = rangeMax - rangeMin;
  const paddingAmount = range * padding;
  
  // Ensure we have some range even if data is flat
  const minRange = Math.abs(rangeMin) * 0.01 || 1;
  const actualPadding = Math.max(paddingAmount, minRange);
  
  console.log(`[OverlayRenderer] Y-range calculation for ${paneId}: data(${dataMin}-${dataMax}), hlines(${hlineYs.join(',')}), result(${rangeMin - actualPadding}-${rangeMax + actualPadding})`);
  
  return new NumberRange(rangeMin - actualPadding, rangeMax + actualPadding);
}

/**
 * Render horizontal line overlays on a chart surface using HorizontalLineAnnotation
 * These annotations stay fixed at their Y value regardless of zoom/pan
 */
export function renderHorizontalLines(
  surface: SciChartSurface,
  _wasm: unknown, // kept for API compatibility but not used
  hlines: HLineConfig[],
  paneId: string
): void {
  // Remove existing horizontal lines for this pane
  const existingKey = `${paneId}-hline`;
  const existing = overlayAnnotationsMap.get(existingKey);
  if (existing) {
    existing.forEach(annotation => {
      try {
        surface.annotations.remove(annotation);
        annotation.delete();
      } catch (e) {
        // Ignore errors during cleanup
      }
    });
    overlayAnnotationsMap.delete(existingKey);
  }

  // Store Y values for Y-axis auto-fit
  const yValues: number[] = [];

  const newAnnotations: HorizontalLineAnnotation[] = [];

  for (const hline of hlines) {
    try {
      const stroke = hline.style?.stroke || '#666666';
      const strokeThickness = hline.style?.strokeThickness || 1;
      const strokeDashArray = hline.style?.strokeDashArray;

      const annotation = new HorizontalLineAnnotation({
        id: `overlay-hline-${hline.id}`,
        y1: hline.y,
        stroke,
        strokeThickness,
        strokeDashArray,
        showLabel: !!hline.label,
        labelPlacement: ELabelPlacement.TopRight,
        labelValue: hline.label || '',
        axisLabelFill: stroke,
        axisFontSize: 11,
        isEditable: false,
      });

      surface.annotations.add(annotation);
      newAnnotations.push(annotation);
      yValues.push(hline.y);

      console.log(`[OverlayRenderer] Rendered HLine ${hline.id} at y=${hline.y}`);
    } catch (error) {
      console.error(`[OverlayRenderer] Failed to render HLine ${hline.id}:`, error);
    }
  }

  // Store Y values for auto-fit
  hlineYValuesMap.set(paneId, yValues);

  if (newAnnotations.length > 0) {
    overlayAnnotationsMap.set(existingKey, newAnnotations);
  }
}

/**
 * Render vertical line overlays on a chart surface using VerticalLineAnnotation
 * These annotations stay fixed at their X value regardless of zoom/pan
 */
export function renderVerticalLines(
  surface: SciChartSurface,
  _wasm: unknown, // kept for API compatibility but not used
  vlines: VLineConfig[],
  paneId: string
): void {
  // Remove existing vertical lines for this pane
  const existingKey = `${paneId}-vline`;
  const existing = overlayAnnotationsMap.get(existingKey);
  if (existing) {
    existing.forEach(annotation => {
      try {
        surface.annotations.remove(annotation);
        annotation.delete();
      } catch (e) {
        // Ignore errors during cleanup
      }
    });
    overlayAnnotationsMap.delete(existingKey);
  }

  const newAnnotations: VerticalLineAnnotation[] = [];

  for (const vline of vlines) {
    try {
      const stroke = vline.style?.stroke || '#FF9800';
      const strokeThickness = vline.style?.strokeThickness || 1;
      const strokeDashArray = vline.style?.strokeDashArray;

      // vline.x should be a timestamp in milliseconds from the JSON
      // CRITICAL: SciChart DateTimeNumericAxis uses SECONDS internally
      // So we must convert milliseconds to seconds
      const xValueMs = typeof vline.x === 'number' ? vline.x : Date.now();
      const xValueSec = xValueMs / 1000;

      const annotation = new VerticalLineAnnotation({
        id: `overlay-vline-${vline.id}`,
        x1: xValueSec,
        stroke,
        strokeThickness,
        strokeDashArray,
        showLabel: !!vline.label,
        labelPlacement: ELabelPlacement.Top,
        labelValue: vline.label || '',
        axisLabelFill: stroke,
        axisFontSize: 11,
        isEditable: false,
      });

      surface.annotations.add(annotation);
      newAnnotations.push(annotation);

      // Enhanced logging with human-readable date
      const dateStr = new Date(xValueMs).toISOString();
      console.log(`[OverlayRenderer] Rendered VLine ${vline.id} at x=${xValueSec} sec (${dateStr})`);

    } catch (error) {
      console.error(`[OverlayRenderer] Failed to render VLine ${vline.id}:`, error);
    }
  }

  if (newAnnotations.length > 0) {
    overlayAnnotationsMap.set(existingKey, newAnnotations);
  }
}

/**
 * Remove all overlays from a surface
 */
export function removeOverlays(surface: SciChartSurface, paneId: string): void {
  const hlineKey = `${paneId}-hline`;
  const vlineKey = `${paneId}-vline`;
  
  [hlineKey, vlineKey].forEach(key => {
    const annotations = overlayAnnotationsMap.get(key);
    if (annotations) {
      annotations.forEach(annotation => {
        try {
          surface.annotations.remove(annotation);
          annotation.delete();
        } catch (e) {
          // Ignore errors during cleanup
        }
      });
      overlayAnnotationsMap.delete(key);
    }
  });
  
  // Clear hline Y values
  hlineYValuesMap.delete(paneId);
  
  console.log(`[OverlayRenderer] Removed all overlays for pane ${paneId}`);
}

