/**
 * Plot Layout Manager
 * Manages dynamic plot layouts, series-to-pane assignments, and overlay rendering
 */

import { parsePlotLayout, ParsedLayout, PlotLayout, getDefaultLayout } from '@/types/plot-layout';
import { parseSeriesType } from '@/lib/series-namespace';

export interface PaneSurface {
  paneId: string;
  surface: any; // SciChartSurface
  wasm: any; // TSciChart
  xAxis: any; // DateTimeNumericAxis
  yAxis: any; // NumericAxis
  containerId: string;
  hasData: boolean; // Whether this pane has received data
  waitingForData: boolean; // Whether to show "Waiting for Data" message
}

export class PlotLayoutManager {
  private parsedLayout: ParsedLayout | null = null;
  private paneSurfaces: Map<string, PaneSurface> = new Map();
  private seriesToPaneMap: Map<string, string> = new Map(); // series_id -> pane.id
  private paneToSeriesMap: Map<string, string[]> = new Map(); // pane.id -> series_id[]

  /**
   * Load and parse a plot layout JSON
   */
  loadLayout(layoutJson: any): ParsedLayout {
    try {
      this.parsedLayout = parsePlotLayout(layoutJson);
      
      // Rebuild series-to-pane maps
      this.seriesToPaneMap.clear();
      this.paneToSeriesMap.clear();
      
      for (const seriesAssignment of this.parsedLayout.layout.series) {
        this.seriesToPaneMap.set(seriesAssignment.series_id, seriesAssignment.pane);
        
        const paneSeries = this.paneToSeriesMap.get(seriesAssignment.pane) || [];
        if (!paneSeries.includes(seriesAssignment.series_id)) {
          paneSeries.push(seriesAssignment.series_id);
        }
        this.paneToSeriesMap.set(seriesAssignment.pane, paneSeries);
      }
      
    
      
      return this.parsedLayout;
    } catch (error) {
      console.error('[PlotLayoutManager] Failed to parse layout:', error);
      throw error;
    }
  }

  /**
   * Get the current parsed layout
   */
  getLayout(): ParsedLayout | null {
    return this.parsedLayout;
  }

  /**
   * Get default layout
   */
  getDefaultLayout(): PlotLayout {
    return getDefaultLayout();
  }

  /**
   * Get which pane a series should be plotted on
   */
  getPaneForSeries(seriesId: string): string | null {
    if (!this.parsedLayout) {
      return null;
    }
    
    // STRICT: Only return pane if series is explicitly assigned in layout JSON
    // No fallback routing - layout is the single source of truth
    const assignedPane = this.seriesToPaneMap.get(seriesId);
    if (assignedPane) {
      return assignedPane;
    }
    
    // Series not defined in layout - do NOT plot it
    return null;
  }

  /**
   * Get all series assigned to a pane
   */
  getSeriesForPane(paneId: string): string[] {
    return this.paneToSeriesMap.get(paneId) || [];
  }

  /**
   * Check if a pane should show strategy markers
   */
  shouldShowStrategyMarkers(paneId: string): boolean {
    if (!this.parsedLayout) {
      return false;
    }
    return this.parsedLayout.strategyMarkerPanes.has(paneId);
  }

  /**
   * Register a pane surface
   */
  registerPane(paneId: string, surface: PaneSurface): void {
    this.paneSurfaces.set(paneId, surface);
  }

  /**
   * Get a pane surface
   */
  getPaneSurface(paneId: string): PaneSurface | null {
    return this.paneSurfaces.get(paneId) || null;
  }

  /**
   * Get all pane surfaces
   */
  getAllPaneSurfaces(): PaneSurface[] {
    return Array.from(this.paneSurfaces.values());
  }

  /**
   * Mark that a pane has received data
   */
  markPaneHasData(paneId: string): void {
    const pane = this.paneSurfaces.get(paneId);
    if (pane) {
      pane.hasData = true;
      pane.waitingForData = false;
      
      // Hide "Waiting for Data" UI
      const waitingElement = document.getElementById(`pane-${paneId}-waiting`);
      if (waitingElement) {
        waitingElement.style.display = 'none';
      }
    }
  }

  /**
   * Show "Waiting for Data" message for a pane
   */
  showWaitingForData(paneId: string): void {
    const pane = this.paneSurfaces.get(paneId);
    if (pane) {
      pane.waitingForData = true;
      
      // Show "Waiting for Data" UI
      const waitingElement = document.getElementById(`pane-${paneId}-waiting`);
      if (waitingElement) {
        waitingElement.style.display = 'flex';
      }
    }
  }

  /**
   * Check if a pane is waiting for data
   */
  isPaneWaitingForData(paneId: string): boolean {
    const pane = this.paneSurfaces.get(paneId);
    if (!pane) {
      return true;
    }
    
    // Check if any assigned series has data
    const assignedSeries = this.getSeriesForPane(paneId);
    if (assignedSeries.length === 0) {
      return true; // No series assigned, waiting
    }
    
    return !pane.hasData;
  }

  /**
   * Get grid dimensions
   */
  getGridDimensions(): [number, number] {
    if (!this.parsedLayout) {
      return [2, 1]; // Default 2x1
    }
    return this.parsedLayout.layout.grid;
  }

  /**
   * Get all pane configs
   */
  getPaneConfigs() {
    if (!this.parsedLayout) {
      return [];
    }
    return this.parsedLayout.layout.panes;
  }

  /**
   * Get minimap source series
   */
  getMinimapSourceSeries(): string | null {
    if (!this.parsedLayout) {
      return null;
    }
    return this.parsedLayout.minimapSourceSeries || null;
  }

  /**
   * Clear all panes (cleanup)
   */
  clear(): void {
    this.paneSurfaces.clear();
    this.parsedLayout = null;
    this.seriesToPaneMap.clear();
    this.paneToSeriesMap.clear();
  }
}

