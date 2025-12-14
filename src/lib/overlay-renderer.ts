/**
 * Overlay Renderer
 * Handles rendering of horizontal and vertical line overlays on chart panes
 * Uses XyDataSeries with fixed Y/X values to create overlay lines
 */

import {
  SciChartSurface,
  TSciChart,
  XyDataSeries,
  FastLineRenderableSeries,
  EResamplingMode,
} from 'scichart';
import type { HLineConfig, VLineConfig } from '@/types/plot-layout';

// Store overlay series references for cleanup
const overlaySeriesMap = new Map<string, FastLineRenderableSeries[]>();

/**
 * Render horizontal line overlays on a chart surface
 * Uses XyDataSeries with fixed Y value across X range
 */
export function renderHorizontalLines(
  surface: SciChartSurface,
  wasm: TSciChart,
  hlines: HLineConfig[],
  paneId: string
): void {
  // Remove existing horizontal lines for this pane
  const existingKey = `${paneId}-hline`;
  const existing = overlaySeriesMap.get(existingKey);
  if (existing) {
    existing.forEach(series => {
      try {
        surface.renderableSeries.remove(series);
        series.delete();
      } catch (e) {
        // Ignore errors
      }
    });
    overlaySeriesMap.delete(existingKey);
  }

  const newSeries: FastLineRenderableSeries[] = [];

  for (const hline of hlines) {
    try {
      // Get current X-axis range to create line across visible area
      const xAxis = surface.xAxes.get(0);
      if (!xAxis) continue;

      // Create a data series with two points spanning a wide X range
      // The line will auto-extend as the chart zooms/pans
      const xMin = Date.now() - 365 * 24 * 60 * 60 * 1000; // 1 year ago
      const xMax = Date.now() + 365 * 24 * 60 * 60 * 1000; // 1 year ahead
      
      const dataSeries = new XyDataSeries(wasm, {
        dataSeriesName: `overlay-hline-${hline.id}`,
        containsNaN: false,
        dataIsSortedInX: true,
        dataEvenlySpacedInX: false,
      });

      // Add two points to create a horizontal line
      dataSeries.append(xMin, hline.y);
      dataSeries.append(xMax, hline.y);

      // Create renderable series
      const stroke = hline.style?.stroke || '#666666';
      const strokeThickness = hline.style?.strokeThickness || 1;
      const strokeDashArray = hline.style?.strokeDashArray;

      const renderableSeries = new FastLineRenderableSeries(wasm, {
        dataSeries,
        stroke,
        strokeThickness,
        resamplingMode: EResamplingMode.None, // No resampling for overlay lines
        isVisible: true,
      });

      // Apply dash array if specified
      if (strokeDashArray && strokeDashArray.length > 0) {
        // Note: SciChart may not support strokeDashArray directly on FastLineRenderableSeries
        // This would need to be implemented using a custom renderable series or annotation
        // For now, we'll log it
      
      }

      surface.renderableSeries.add(renderableSeries);
      newSeries.push(renderableSeries);

    
    } catch (error) {
      console.error(`[OverlayRenderer] Failed to render HLine ${hline.id}:`, error);
    }
  }

  if (newSeries.length > 0) {
    overlaySeriesMap.set(existingKey, newSeries);
  }
}

/**
 * Render vertical line overlays on a chart surface
 * Uses XyDataSeries with fixed X value across Y range
 */
export function renderVerticalLines(
  surface: SciChartSurface,
  wasm: TSciChart,
  vlines: VLineConfig[],
  paneId: string
): void {
  // Remove existing vertical lines for this pane
  const existingKey = `${paneId}-vline`;
  const existing = overlaySeriesMap.get(existingKey);
  if (existing) {
    existing.forEach(series => {
      try {
        surface.renderableSeries.remove(series);
        series.delete();
      } catch (e) {
        // Ignore errors
      }
    });
    overlaySeriesMap.delete(existingKey);
  }

  const newSeries: FastLineRenderableSeries[] = [];

  for (const vline of vlines) {
    try {
      // Get current Y-axis range to create line across visible area
      const yAxis = surface.yAxes.get(0);
      if (!yAxis) continue;

      // Create a data series with two points spanning a wide Y range
      // Use a large Y range that will cover most use cases
      const yMin = -1e10;
      const yMax = 1e10;
      
      const dataSeries = new XyDataSeries(wasm, {
        dataSeriesName: `overlay-vline-${vline.id}`,
        containsNaN: false,
        dataIsSortedInX: true,
        dataEvenlySpacedInX: false,
      });

      // Add two points to create a vertical line
      // Note: vline.x might be a timestamp or a relative value
      // For now, treat it as a timestamp
      const xValue = typeof vline.x === 'number' ? vline.x : Date.now();
      dataSeries.append(xValue, yMin);
      dataSeries.append(xValue, yMax);

      // Create renderable series
      const stroke = vline.style?.stroke || '#FF9800';
      const strokeThickness = vline.style?.strokeThickness || 1;
      const strokeDashArray = vline.style?.strokeDashArray;

      const renderableSeries = new FastLineRenderableSeries(wasm, {
        dataSeries,
        stroke,
        strokeThickness,
        resamplingMode: EResamplingMode.None,
        isVisible: true,
      });

      // Apply dash array if specified
      if (strokeDashArray && strokeDashArray.length > 0) {
       
      }

      surface.renderableSeries.add(renderableSeries);
      newSeries.push(renderableSeries);

   
    } catch (error) {
      console.error(`[OverlayRenderer] Failed to render VLine ${vline.id}:`, error);
    }
  }

  if (newSeries.length > 0) {
    overlaySeriesMap.set(existingKey, newSeries);
  }
}

/**
 * Remove all overlays from a surface
 */
export function removeOverlays(surface: SciChartSurface, paneId: string): void {
  const hlineKey = `${paneId}-hline`;
  const vlineKey = `${paneId}-vline`;
  
  [hlineKey, vlineKey].forEach(key => {
    const series = overlaySeriesMap.get(key);
    if (series) {
      series.forEach(s => {
        try {
          surface.renderableSeries.remove(s);
          s.delete();
        } catch (e) {
          // Ignore errors
        }
      });
      overlaySeriesMap.delete(key);
    }
  });
  
 
}

