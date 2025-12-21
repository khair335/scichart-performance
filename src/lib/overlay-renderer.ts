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
} from 'scichart';
import type { HLineConfig, VLineConfig } from '@/types/plot-layout';

// Store overlay annotation references for cleanup
const overlayAnnotationsMap = new Map<string, (HorizontalLineAnnotation | VerticalLineAnnotation)[]>();

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

      console.log(`[OverlayRenderer] Rendered HLine ${hline.id} at y=${hline.y}`);
    } catch (error) {
      console.error(`[OverlayRenderer] Failed to render HLine ${hline.id}:`, error);
    }
  }

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

      // vline.x should be a timestamp in milliseconds
      const xValue = typeof vline.x === 'number' ? vline.x : Date.now();

      const annotation = new VerticalLineAnnotation({
        id: `overlay-vline-${vline.id}`,
        x1: xValue,
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

      console.log(`[OverlayRenderer] Rendered VLine ${vline.id} at x=${xValue}`);
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
  
  console.log(`[OverlayRenderer] Removed all overlays for pane ${paneId}`);
}

