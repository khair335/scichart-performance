/**
 * Dynamic Pane Manager
 * Handles creation, management, and cleanup of dynamic chart panes using SubCharts API
 * SubCharts API provides dramatically better performance by sharing a single WebGL context
 * across all panes instead of creating separate contexts per pane.
 */

import {
  SciChartSurface,
  SciChartSubSurface,
  NumericAxis,
  DateTimeNumericAxis,
  TSciChart,
  EAutoRange,
  EAxisAlignment,
  NumberRange,
  SciChartVerticalGroup,
  ZoomPanModifier,
  ZoomExtentsModifier,
  MouseWheelZoomModifier,
  RubberBandXyZoomModifier,
  EXyDirection,
  Rect,
  ESubSurfacePositionCoordinateMode,
} from 'scichart';
import type { ParsedLayout, PaneConfig } from '@/types/plot-layout';

export interface PaneSurface {
  surface: SciChartSurface;
  wasm: TSciChart;
  xAxis: DateTimeNumericAxis;
  yAxis: NumericAxis;
  containerId: string;
  paneId: string;
  paneConfig: PaneConfig;
  hasData?: boolean; // Optional: tracks if pane has received data
  waitingForData?: boolean; // Optional: tracks if pane is waiting for data
}

export interface ChartTheme {
  type: 'Dark';
  axisBorder: string;
  axisTitleColor: string;
  annotationsGripsBackgroundBrush: string;
  annotationsGripsBorderBrush: string;
  axis3DBandsFill: string;
  axisBandsFill: string;
  gridBackgroundBrush: string;
  gridBorderBrush: string;
  loadingAnimationBackground: string;
  loadingAnimationForeground: string;
  majorGridLineBrush: string;
  minorGridLineBrush: string;
  sciChartBackground: string;
  tickTextBrush: string;
  labelBackgroundBrush: string;
  labelBorderBrush: string;
  labelForegroundBrush: string;
  textAnnotationBackground: string;
  textAnnotationForeground: string;
  cursorLineBrush: string;
  rolloverLineStroke: string;
}

export type ZoomMode = 'box' | 'x-only' | 'y-only';

export class DynamicPaneManager {
  private paneSurfaces: Map<string, PaneSurface> = new Map();
  private sharedWasm: TSciChart | null = null;
  private verticalGroup: SciChartVerticalGroup | null = null;
  private theme: ChartTheme;
  private zoomMode: ZoomMode = 'box'; // Default zoom mode
  private timezone: string = 'UTC'; // Timezone for DateTime axis formatting
  private parentSurface: SciChartSurface | null = null; // Parent surface for SubCharts API
  private gridRows: number = 1; // Current grid rows
  private gridCols: number = 1; // Current grid cols

  constructor(theme: ChartTheme, timezone: string = 'UTC') {
    this.theme = theme;
    this.timezone = timezone;
  }

  /**
   * Initialize parent surface for SubCharts API
   * This must be called once before creating any panes
   * @param containerId - ID of the HTML container element
   * @param gridRows - Number of rows in the grid
   * @param gridCols - Number of columns in the grid
   */
  async initializeParentSurface(
    containerId: string,
    gridRows: number,
    gridCols: number
  ): Promise<void> {
    if (this.parentSurface) {
      return;
    }

    this.gridRows = gridRows;
    this.gridCols = gridCols;

    const result = await SciChartSurface.create(containerId, {
      theme: this.theme,
      freezeWhenOutOfView: true, // Freeze charts when out of viewport for better performance
    });

    this.parentSurface = result.sciChartSurface;
    this.sharedWasm = result.wasmContext;

    this.verticalGroup = new SciChartVerticalGroup();

    // Wait for the rendering context to be fully ready
    // The parent surface needs time to initialize its WebGL context and render surface
    // Force an initial render to ensure all contexts are initialized
    await new Promise(resolve => requestAnimationFrame(resolve));

    // Check if renderSurface is initialized
    let attempts = 0;
    while (attempts < 50 && !(this.parentSurface as any).renderSurface?.context2D) {
      await new Promise(resolve => setTimeout(resolve, 20));
      attempts++;
    }

    // Additional frames for safety
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
  }

  /**
   * Get the shared WASM context
   */
  getWasmContext(): TSciChart | null {
    return this.sharedWasm;
  }

  /**
   * Set timezone for DateTime axis formatting
   */
  setTimezone(timezone: string): void {
    this.timezone = timezone;
    // Update existing panes' X-axes
    for (const [paneId, paneSurface] of this.paneSurfaces) {
      this.updateAxisTimezone(paneSurface.xAxis);
    }
  }

  /**
   * Update DateTime axis with timezone-aware formatting
   * Note: Currently disabled - letting SciChart use its default intelligent formatting
   * which automatically adapts based on zoom level (e.g., "08:25" when zoomed in, "12/08" when zoomed out)
   */
  private updateAxisTimezone(xAxis: DateTimeNumericAxis): void {
    // No-op: Let SciChart handle datetime formatting automatically
    // SciChart's DateTimeNumericAxis automatically adjusts format based on visible range
  }

  /**
   * Set zoom mode for all panes
   */
  setZoomMode(mode: ZoomMode): void {
    this.zoomMode = mode;
    // Update modifiers for all existing panes
    for (const [paneId, paneSurface] of this.paneSurfaces) {
      this.updateZoomModifiers(paneSurface.surface);
    }
  }

  /**
   * Get current zoom mode
   */
  getZoomMode(): ZoomMode {
    return this.zoomMode;
  }

  /**
   * Update zoom modifiers based on current zoom mode
   */
  private updateZoomModifiers(surface: SciChartSurface): void {
    // Remove existing zoom modifiers
    const modifiersToRemove: any[] = [];
    surface.chartModifiers.asArray().forEach((mod: any) => {
      if (mod instanceof MouseWheelZoomModifier || 
          mod instanceof RubberBandXyZoomModifier) {
        modifiersToRemove.push(mod);
      }
    });
    modifiersToRemove.forEach(mod => surface.chartModifiers.remove(mod));

    // Add modifiers based on zoom mode
    switch (this.zoomMode) {
      case 'x-only':
        // X-only: wheel zooms X, box zoom disabled
        surface.chartModifiers.add(
          new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection })
        );
        break;
      case 'y-only':
        // Y-only: wheel zooms Y, box zoom disabled
        surface.chartModifiers.add(
          new MouseWheelZoomModifier({ xyDirection: EXyDirection.YDirection })
        );
        break;
      case 'box':
      default:
        // Box mode: wheel zooms X (with Shift for Y), box zoom enabled
        const wheelModifier = new MouseWheelZoomModifier({ 
          xyDirection: EXyDirection.XDirection 
        });
        // Override for Shift+wheel Y zoom
        const originalOnWheel = (wheelModifier as any).onWheel;
        if (originalOnWheel) {
          (wheelModifier as any).onWheel = (args: any) => {
            if (args.modifierKeyState?.shiftKey) {
              const tempDirection = wheelModifier.xyDirection;
              wheelModifier.xyDirection = EXyDirection.YDirection;
              try {
                originalOnWheel.call(wheelModifier, args);
              } finally {
                wheelModifier.xyDirection = tempDirection;
              }
            } else {
              originalOnWheel.call(wheelModifier, args);
            }
          };
        }
        surface.chartModifiers.add(
          wheelModifier,
          new RubberBandXyZoomModifier({ isAnimated: false }),
          new ZoomPanModifier(), // Enable pan with mouse drag
          new ZoomExtentsModifier() // Enable double-click to zoom extents
        );
        break;
    }
  }

  /**
   * Create a vertical group for linking X-axes (called once)
   */
  createVerticalGroup(wasm: TSciChart): SciChartVerticalGroup {
    if (this.verticalGroup) {
      return this.verticalGroup;
    }
    this.verticalGroup = new SciChartVerticalGroup();
    return this.verticalGroup;
  }

  /**
   * Create a new pane surface using SubCharts API
   * This creates a sub-chart within the parent surface, sharing the WebGL context
   */
  async createPane(
    paneId: string,
    containerId: string,
    paneConfig: PaneConfig,
    maxAutoTicks: number = 8,
    separateXAxes: boolean = true
  ): Promise<PaneSurface> {
    // Check if pane already exists
    if (this.paneSurfaces.has(paneId)) {
      return this.paneSurfaces.get(paneId)!;
    }

    // Ensure parent surface is initialized
    if (!this.parentSurface || !this.sharedWasm) {
      throw new Error('Parent surface not initialized. Call initializeParentSurface() first.');
    }

    // Calculate position in grid using relative coordinates (0-1 range)
    const colWidth = 1 / this.gridCols;
    const rowHeight = 1 / this.gridRows;

    const x = paneConfig.col * colWidth;
    const y = paneConfig.row * rowHeight;
    const width = paneConfig.width * colWidth;
    const height = paneConfig.height * rowHeight;

    // Create sub-chart using SciChartSubSurface API
    const subSurface = SciChartSubSurface.createSubSurface(this.parentSurface, {
      position: new Rect(x, y, width, height),
      coordinateMode: ESubSurfacePositionCoordinateMode.Relative,
      isTransparent: false,
    });

    const surface = subSurface as SciChartSurface;
    const wasmContext = this.sharedWasm;

    // Wait for the subsurface rendering context to be ready
    // This is critical - the subsurface needs time to initialize its rendering context
    // Poll for the renderSurface to be ready with text measurement capabilities
    let attempts = 0;
    const maxAttempts = 50; // 50 attempts * 20ms = 1 second max wait
    while (attempts < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, 20));
      // Check if the rendering context is ready by checking for renderSurface
      const renderSurface = (surface as any).renderSurface;
      if (renderSurface && renderSurface.context2D) {
        // Context is ready
        break;
      }
      attempts++;
    }

    if (attempts >= maxAttempts) {
      console.warn('[DynamicPaneManager] Subsurface rendering context did not initialize in time');
    }

    // Additional animation frames for safety
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));

    // Create axes - let SciChart use its default intelligent datetime formatting
    // SciChart automatically adapts the format based on zoom level (e.g., "08:25" when zoomed in, "12/08" when zoomed out)
    const xAxis = new DateTimeNumericAxis(wasmContext, {
      autoRange: EAutoRange.Once,
      drawMajorGridLines: true, // Enable grid lines
      drawMinorGridLines: false, // Disable minor grid lines for better performance
      drawMajorTickLines: true,
      drawMinorTickLines: false, // Disable minor ticks for better performance
      isVisible: true,
      useNativeText: true,
      useSharedCache: true,
      maxAutoTicks: maxAutoTicks,
      // Don't set axisTitle - causes text rendering issues with subsurfaces
      // axisTitle: "Time",
      // axisTitleStyle: { color: "#9fb2c9" },
      labelStyle: { color: "#9fb2c9" },
    });

    const yAxis = new NumericAxis(wasmContext, {
      autoRange: EAutoRange.Once,
      drawMajorGridLines: true, // Enable grid lines
      drawMinorGridLines: false, // Disable minor grid lines for better performance
      drawMajorTickLines: true,
      drawMinorTickLines: false, // Disable minor ticks for better performance
      axisAlignment: EAxisAlignment.Right,
      useNativeText: true,
      useSharedCache: true,
      maxAutoTicks: 3,
      growBy: new NumberRange(0.1, 0.1),
      // Don't set axisTitle - causes text rendering issues with subsurfaces
      // axisTitle: "Price",
      // axisTitleStyle: { color: "#9fb2c9" },
      labelStyle: { color: "#9fb2c9" },
    });

    surface.xAxes.add(xAxis);
    surface.yAxes.add(yAxis);

    // Add chart modifiers for zoom/pan interaction
    // Note: MouseWheelZoomModifier should be added before ZoomPanModifier to ensure it works
    
    const zoomExtentsModifier = new ZoomExtentsModifier();
    
    // Add base modifiers (pan, zoom extents)
    surface.chartModifiers.add(
      new ZoomPanModifier({ enableZoom: false }), // Enable pan (dragging) only, disable zoom gestures
      zoomExtentsModifier,
    );
    
    // Add zoom modifiers based on current zoom mode
    this.updateZoomModifiers(surface);
    
    // Double-click = fit-all + pause
    // ZoomExtentsModifier already handles double-click for fit-all
    // We'll add pause callback via surface event (if available)
    // Note: The pause logic will be handled in MultiPaneChart via setLiveMode callback

    // Add to vertical group to link X-axes across all panes
    // Requirement 17: All panes must have their own X-axis, all linked and synchronized
    // Note: separateXAxes parameter is kept for backward compatibility but all panes are linked
    if (this.verticalGroup) {
      this.verticalGroup.addSurfaceToGroup(surface);
    }

    const paneSurface: PaneSurface = {
      surface,
      wasm: wasmContext,
      xAxis,
      yAxis,
      containerId,
      paneId,
      paneConfig,
      hasData: false,
      waitingForData: true,
    };

    this.paneSurfaces.set(paneId, paneSurface);
    return paneSurface;
  }

  /**
   * Get a pane surface by ID
   */
  getPane(paneId: string): PaneSurface | null {
    return this.paneSurfaces.get(paneId) || null;
  }

  /**
   * Get all pane surfaces
   */
  getAllPanes(): PaneSurface[] {
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
    }
  }

  /**
   * Check if a pane is waiting for data
   */
  isPaneWaitingForData(paneId: string): boolean {
    const pane = this.paneSurfaces.get(paneId);
    return pane ? pane.waitingForData : true;
  }

  /**
   * Destroy a pane
   * NOTE: RenderableSeries should be removed BEFORE calling this, as deleting the surface
   * will invalidate any remaining RenderableSeries references
   */
  destroyPane(paneId: string): void {
    const pane = this.paneSurfaces.get(paneId);
    if (pane) {
      // Remove from vertical group if linked
      // Note: SciChartVerticalGroup doesn't have removeSurfaceFromGroup method
      // The group will automatically handle cleanup when surface is deleted
      // if (this.verticalGroup) {
      //   try {
      //     this.verticalGroup.removeSurfaceFromGroup(pane.surface);
      //   } catch (e) {
      //     // Ignore errors if surface not in group
      //   }
      // }
      
      // CRITICAL: Suspend updates first to prevent render attempts during cleanup
      try {
        pane.surface.suspendUpdates();
      } catch (e) {
        // Ignore
      }

      // CRITICAL: Clear modifiers first to prevent DOM access after surface removal
      try {
        pane.surface.chartModifiers.clear();
      } catch (e) {
        console.warn(`[DynamicPaneManager] Error clearing modifiers from pane ${paneId}:`, e);
      }

      // CRITICAL: Remove all RenderableSeries before deleting surface
      // This prevents "DataSeries has been deleted" errors
      try {
        const renderableSeriesToRemove: any[] = [];
        pane.surface.renderableSeries.asArray().forEach((rs: any) => {
          renderableSeriesToRemove.push(rs);
        });

        for (const rs of renderableSeriesToRemove) {
          try {
            pane.surface.renderableSeries.remove(rs);
          } catch (e) {
            // Ignore if already removed
          }
        }
      } catch (e) {
        console.warn(`[DynamicPaneManager] Error removing RenderableSeries from pane ${paneId}:`, e);
      }

      // Delete surface (DataSeries are NOT deleted - they're managed separately)
      try {
        pane.surface.delete();
      } catch (e) {
        console.warn(`[DynamicPaneManager] Error deleting pane ${paneId}:`, e);
      }
      
      this.paneSurfaces.delete(paneId);
    }
  }

  /**
   * Destroy all panes
   */
  destroyAllPanes(): void {
    // First suspend updates on all panes to prevent render attempts
    for (const pane of this.paneSurfaces.values()) {
      try {
        pane.surface.suspendUpdates();
      } catch (e) {
        // Ignore
      }
    }

    // Then destroy each pane
    const paneIds = Array.from(this.paneSurfaces.keys());
    for (const paneId of paneIds) {
      this.destroyPane(paneId);
    }
  }

  /**
   * Get shared WASM context
   */
  getSharedWasm(): TSciChart | null {
    return this.sharedWasm;
  }

  /**
   * Get vertical group
   */
  getVerticalGroup(): SciChartVerticalGroup | null {
    return this.verticalGroup;
  }

  /**
   * Cleanup all resources
   */
  async cleanup(): Promise<void> {
    // Store parent surface reference and clear immediately to prevent re-entry
    const parentToDelete = this.parentSurface;
    this.parentSurface = null;

    if (!parentToDelete) {
      // Already cleaned up
      return;
    }

    // Suspend all rendering first to stop render loops
    try {
      parentToDelete.suspendUpdates();
    } catch (e) {
      // Ignore - may already be deleted
    }

    // CRITICAL: Clear all series AND axes before suspending to prevent render errors
    for (const pane of this.paneSurfaces.values()) {
      // First remove all series
      try {
        pane.surface.renderableSeries.clear();
      } catch (e) {
        // Ignore
      }

      // Then remove all axes
      try {
        pane.surface.xAxes.clear();
        pane.surface.yAxes.clear();
      } catch (e) {
        // Ignore
      }

      // Finally suspend rendering
      try {
        pane.surface.suspendUpdates();
      } catch (e) {
        // Ignore
      }
    }

    // CRITICAL: Wait for WASM render loop to fully stop
    // The render loop runs at ~60fps, so we need to wait multiple frames
    // PLUS additional time for WASM event processing
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    // CRITICAL: Additional delay for WASM to fully process pending events
    await new Promise(resolve => setTimeout(resolve, 400));

    // Remove all surfaces from vertical group
    // Note: Don't call delete() - just remove surfaces and let it be garbage collected
    if (this.verticalGroup) {
      try {
        // Remove all surfaces from the group
        for (const pane of this.paneSurfaces.values()) {
          try {
            this.verticalGroup.remove(pane.surface);
          } catch (e) {
            // Ignore if already removed
          }
        }
      } catch (e) {
        console.warn('[DynamicPaneManager] Error clearing vertical group:', e);
      }
      this.verticalGroup = null;
    }

    // Clear modifiers and series from all panes before parent deletion
    for (const pane of this.paneSurfaces.values()) {
      try {
        pane.surface.chartModifiers.clear();
      } catch (e) {
        // Ignore
      }

      try {
        const renderableSeriesToRemove: any[] = [];
        pane.surface.renderableSeries.asArray().forEach((rs: any) => {
          renderableSeriesToRemove.push(rs);
        });
        for (const rs of renderableSeriesToRemove) {
          try {
            pane.surface.renderableSeries.remove(rs);
          } catch (e) {
            // Ignore
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    // Clear the panes map WITHOUT calling delete on subsurfaces
    // The parent.delete() will cascade delete all subsurfaces automatically
    this.paneSurfaces.clear();

    // Delete parent surface LAST - this cascades to all subsurfaces
    // Catch "already deleted" errors from SciChart
    try {
      parentToDelete.delete();
    } catch (e: any) {
      // Silently ignore "already deleted" errors, warn on others
      if (!e?.message?.includes('already been deleted')) {
        console.warn('[DynamicPaneManager] Error deleting parent surface:', e);
      }
    }

    this.sharedWasm = null;
    this.gridRows = 1;
    this.gridCols = 1;
  }
}

