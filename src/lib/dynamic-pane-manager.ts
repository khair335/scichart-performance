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
  XAxisDragModifier,
  YAxisDragModifier,
  EXyDirection,
  Rect,
  ESubSurfacePositionCoordinateMode,
  SciChartDefaults,
  DpiHelper,
  EExecuteOn,
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
  type: 'Dark' | 'Light';
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

    // PERF: Apply global SciChart performance settings BEFORE creating surfaces
    DpiHelper.IsDpiScaleEnabled = false; // Disable DPI scaling for 4x better performance on Retina
    SciChartDefaults.useNativeText = true; // Use native WebGL text rendering
    SciChartDefaults.useSharedCache = true; // Share label cache across charts
    SciChartDefaults.performanceWarnings = false; // Disable perf warnings for production

    const result = await SciChartSurface.create(containerId, {
      theme: this.theme,
      freezeWhenOutOfView: true, // PERF: Freeze charts when out of viewport
    });

    this.parentSurface = result.sciChartSurface;
    this.sharedWasm = result.wasmContext;

    this.verticalGroup = new SciChartVerticalGroup();

    // CRITICAL: Patch MouseManager to filter out undefined/null subCharts
    // This prevents "Cannot read properties of undefined (reading 'isOver')" errors
    try {
      const mouseManager = (this.parentSurface as any).mouseManager;
      if (mouseManager && mouseManager.updateSubCharts) {
        const originalUpdateSubCharts = mouseManager.updateSubCharts.bind(mouseManager);
        mouseManager.updateSubCharts = function(...args: any[]) {
          // Filter out undefined/null subCharts before processing
          if (this.subCharts && Array.isArray(this.subCharts)) {
            this.subCharts = this.subCharts.filter((chart: any) => chart != null);
          }
          return originalUpdateSubCharts(...args);
        };
      }
    } catch (e) {
      // Ignore if patching fails - not critical
      console.warn('[DynamicPaneManager] Could not patch MouseManager:', e);
    }

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
   * Update theme for all existing surfaces
   */
  setTheme(theme: ChartTheme): void {
    this.theme = theme;
    
    // Update parent surface background
    if (this.parentSurface) {
      this.parentSurface.background = theme.sciChartBackground;
    }
    
    // Update all pane surfaces
    for (const [paneId, paneSurface] of this.paneSurfaces) {
      const surface = paneSurface.surface;
      
      // Update surface background
      surface.background = theme.sciChartBackground;
      
      // Update X-axis styles
      const xAxis = paneSurface.xAxis;
      xAxis.axisTitleStyle = { ...xAxis.axisTitleStyle, color: theme.axisTitleColor };
      xAxis.labelStyle = { ...xAxis.labelStyle, color: theme.tickTextBrush };
      xAxis.majorGridLineStyle = { ...xAxis.majorGridLineStyle, color: theme.majorGridLineBrush };
      xAxis.minorGridLineStyle = { ...xAxis.minorGridLineStyle, color: theme.minorGridLineBrush };
      
      // Update Y-axis styles
      const yAxis = paneSurface.yAxis;
      yAxis.axisTitleStyle = { ...yAxis.axisTitleStyle, color: theme.axisTitleColor };
      yAxis.labelStyle = { ...yAxis.labelStyle, color: theme.tickTextBrush };
      yAxis.majorGridLineStyle = { ...yAxis.majorGridLineStyle, color: theme.majorGridLineBrush };
      yAxis.minorGridLineStyle = { ...yAxis.minorGridLineStyle, color: theme.minorGridLineBrush };
      
      // Invalidate surface to trigger redraw
      surface.invalidateElement();
    }
  }

  /**
   * Get current theme
   */
  getTheme(): ChartTheme {
    return this.theme;
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
    // Remove existing zoom-related modifiers (but keep axis drag modifiers)
    const modifiersToRemove: any[] = [];
    surface.chartModifiers.asArray().forEach((mod: any) => {
      if (mod instanceof MouseWheelZoomModifier || 
          mod instanceof RubberBandXyZoomModifier ||
          mod instanceof ZoomPanModifier ||
          mod instanceof ZoomExtentsModifier) {
        modifiersToRemove.push(mod);
      }
    });
    modifiersToRemove.forEach(mod => surface.chartModifiers.remove(mod));

    // Add modifiers based on zoom mode
    // CRITICAL: Order matters - add in order of priority
    switch (this.zoomMode) {
      case 'x-only':
        // X-only mode: wheel zooms X only, no box zoom, right-click drag pans
        surface.chartModifiers.add(
          new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection }),
          new ZoomPanModifier({ 
            executeCondition: { button: EExecuteOn.MouseRightButton }
          }),
          new ZoomExtentsModifier()
        );
        break;
      case 'y-only':
        // Y-only mode: wheel zooms Y only, no box zoom, right-click drag pans
        surface.chartModifiers.add(
          new MouseWheelZoomModifier({ xyDirection: EXyDirection.YDirection }),
          new ZoomPanModifier({ 
            executeCondition: { button: EExecuteOn.MouseRightButton }
          }),
          new ZoomExtentsModifier()
        );
        break;
      case 'box':
      default:
        // Box mode: 
        // - Left drag = box zoom (rubber band)
        // - Right-click drag = pan
        // - Wheel = X zoom
        // - Shift+wheel = Y zoom
        const wheelModifier = new MouseWheelZoomModifier({ 
          xyDirection: EXyDirection.XDirection 
        });
        
        // Override wheel handler for Shift+wheel Y zoom
        const originalModifierMouseWheel = (wheelModifier as any).modifierMouseWheel;
        if (originalModifierMouseWheel) {
          (wheelModifier as any).modifierMouseWheel = (args: any) => {
            if (args.mouseArgs?.ctrlKey || args.mouseArgs?.shiftKey) {
              // Temporarily switch to Y direction for Shift/Ctrl+wheel
              const tempDirection = wheelModifier.xyDirection;
              wheelModifier.xyDirection = EXyDirection.YDirection;
              try {
                originalModifierMouseWheel.call(wheelModifier, args);
              } finally {
                wheelModifier.xyDirection = tempDirection;
              }
            } else {
              originalModifierMouseWheel.call(wheelModifier, args);
            }
          };
        }
        
        surface.chartModifiers.add(
          new RubberBandXyZoomModifier({ 
            isAnimated: false,
            executeCondition: { button: EExecuteOn.MouseLeftButton }
          }),
          new ZoomPanModifier({ 
            executeCondition: { button: EExecuteOn.MouseRightButton }
          }),
          wheelModifier,
          new ZoomExtentsModifier()
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

    // CRITICAL: Suspend parent surface updates during subsurface creation
    // This prevents the render loop from accessing partially initialized subsurfaces
    this.parentSurface.suspendUpdates();

    let surface: SciChartSurface;
    const wasmContext = this.sharedWasm;

    try {
      // Create sub-chart using SciChartSubSurface API
      const subSurface = SciChartSubSurface.createSubSurface(this.parentSurface, {
        position: new Rect(x, y, width, height),
        coordinateMode: ESubSurfacePositionCoordinateMode.Relative,
        isTransparent: false,
      });

      surface = subSurface as SciChartSurface;

      // Wait briefly for the subsurface to initialize
      // Don't wait too long - SciChart will handle context initialization asynchronously
      // The surface exists, which is enough to proceed with configuration
      await new Promise(resolve => requestAnimationFrame(resolve));
      await new Promise(resolve => requestAnimationFrame(resolve));

    } finally {
      // Resume updates after subsurface is fully initialized
      this.parentSurface.resumeUpdates();
    }

    // CRITICAL: Suspend updates while configuring axes and modifiers
    // This prevents the render loop from accessing partially configured surfaces
    // Keep suspended until axes are fully configured and context is verified
    surface.suspendUpdates();
    
    let xAxis: DateTimeNumericAxis;
    let yAxis: NumericAxis;
    
    try {
      // Create axes - let SciChart use its default intelligent datetime formatting
      // SciChart automatically adapts the format based on zoom level (e.g., "08:25" when zoomed in, "12/08" when zoomed out)
      xAxis = new DateTimeNumericAxis(wasmContext, {
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

      yAxis = new NumericAxis(wasmContext, {
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
      
      // Give one more frame for axes to be fully configured
      await new Promise(resolve => requestAnimationFrame(resolve));

      // Add chart modifiers for zoom/pan interaction
      // CRITICAL: Add axis drag modifiers FIRST for axis stretching/shrinking
      // These allow users to drag on the axis to stretch/shrink the range
      surface.chartModifiers.add(
        new XAxisDragModifier(), // Drag on X-axis to stretch/shrink
        new YAxisDragModifier(), // Drag on Y-axis to stretch/shrink
      );
      
      // Add zoom modifiers based on current zoom mode
      // This adds the appropriate modifiers for panning, box zoom, wheel zoom
      this.updateZoomModifiers(surface);
      
      // Double-click = fit-all + pause
      // ZoomExtentsModifier already handles double-click for fit-all
      // We'll add pause callback via surface event (if available)
      // Note: The pause logic will be handled in MultiPaneChart via setLiveMode callback
    } finally {
      surface.resumeUpdates();
    }

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
      // CRITICAL: Suspend updates first to prevent render attempts during cleanup
      try {
        pane.surface.suspendUpdates();
      } catch (e) {
        // Ignore
      }

      // CRITICAL: Clear modifiers first to prevent DOM access after surface removal
      // Detach modifiers from their parentSurface to prevent 'isOver' errors
      try {
        const modifiers = pane.surface.chartModifiers.asArray();
        for (const mod of modifiers) {
          try {
            (mod as any).parentSurface = null;
          } catch (e) { /* ignore */ }
        }
        pane.surface.chartModifiers.clear();
      } catch (e) {
        // Ignore errors silently
      }

      // CRITICAL: First, detach ALL dataSeries references from renderableSeries
      // This prevents "dataSeries has been deleted" errors
      try {
        const seriesArray = pane.surface.renderableSeries.asArray();
        for (const rs of seriesArray) {
          try {
            if ((rs as any).dataSeries) {
              (rs as any).dataSeries = null;
            }
          } catch (e) {
            // Ignore
          }
        }
      } catch (e) {
        // Ignore
      }

      // CRITICAL: Remove all RenderableSeries before deleting surface
      try {
        pane.surface.renderableSeries.clear();
      } catch (e) {
        // Ignore errors silently
      }

      // CRITICAL: Remove subsurface from parent's subCharts array before deleting
      // This prevents MouseManager from accessing undefined subCharts
      if (this.parentSurface) {
        try {
          // Access the parent surface's subCharts array and remove this subsurface
          const parentSubCharts = (this.parentSurface as any).subCharts;
          if (parentSubCharts && Array.isArray(parentSubCharts)) {
            const index = parentSubCharts.indexOf(pane.surface);
            if (index !== -1) {
              parentSubCharts.splice(index, 1);
            }
          }
          
          // Also try to access via mouseManager if available
          const mouseManager = (this.parentSurface as any).mouseManager;
          if (mouseManager) {
            // Clear any hover state for this subsurface
            if (mouseManager.subCharts && Array.isArray(mouseManager.subCharts)) {
              const index = mouseManager.subCharts.indexOf(pane.surface);
              if (index !== -1) {
                mouseManager.subCharts.splice(index, 1);
              }
            }
            
            // Clear hover state to prevent isOver errors
            if (mouseManager.hoveredSubChart === pane.surface) {
              mouseManager.hoveredSubChart = null;
            }
          }
        } catch (e) {
          // Ignore - subCharts might not be accessible or already cleaned up
        }
      }

      // Delete surface (DataSeries are NOT deleted - they're managed separately)
      try {
        pane.surface.delete();
      } catch (e: any) {
        // Silently ignore common cleanup errors
        const msg = e?.message || '';
        if (!msg.includes('already been deleted') && !msg.includes('dataSeries has been deleted')) {
          console.warn(`[DynamicPaneManager] Error deleting pane ${paneId}:`, e);
        }
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

    // CRITICAL: Suspend ALL surfaces first before any modifications
    // This prevents the render loop from accessing deleted resources
    try {
      parentToDelete.suspendUpdates();
    } catch (e) {
      // Ignore - may already be deleted
    }
    
    for (const pane of this.paneSurfaces.values()) {
      try {
        pane.surface.suspendUpdates();
      } catch (e) {
        // Ignore
      }
    }

    // CRITICAL: Wait for multiple render frames to ensure the render loop has fully stopped
    // The WASM render loop is async and may still be processing when we suspend
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    
    // Additional timeout for WASM to fully process pending events
    await new Promise(resolve => setTimeout(resolve, 100));

    // CRITICAL: First, detach ALL dataSeries references from renderableSeries
    // This prevents "dataSeries has been deleted" errors when the render loop
    // tries to access the dataSeries during cleanup
    for (const pane of this.paneSurfaces.values()) {
      try {
        const seriesArray = pane.surface.renderableSeries.asArray();
        for (const rs of seriesArray) {
          try {
            // Detach dataSeries reference BEFORE removing
            if ((rs as any).dataSeries) {
              (rs as any).dataSeries = null;
            }
          } catch (e) {
            // Ignore - dataSeries may already be null
          }
        }
      } catch (e) {
        // Ignore
      }
    }

    // Wait a frame after detaching dataSeries references
    await new Promise(resolve => requestAnimationFrame(resolve));

    // NOW clear all series AND axes after dataSeries detached
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
      
      // Clear modifiers - detach parentSurface first to prevent 'isOver' errors
      try {
        const modifiers = pane.surface.chartModifiers.asArray();
        for (const mod of modifiers) {
          try {
            (mod as any).parentSurface = null;
          } catch (e) { /* ignore */ }
        }
        pane.surface.chartModifiers.clear();
      } catch (e) {
        // Ignore
      }
    }

    // CRITICAL: Wait again for WASM render loop to fully stop after clearing
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    await new Promise(resolve => requestAnimationFrame(resolve));
    // CRITICAL: Additional delay for WASM to fully process pending events
    await new Promise(resolve => setTimeout(resolve, 200));

    // CRITICAL: Clean up parent surface's subCharts array and MouseManager references
    // This prevents MouseManager from accessing deleted subCharts
    if (parentToDelete) {
      try {
        // Clear subCharts array
        const parentSubCharts = (parentToDelete as any).subCharts;
        if (parentSubCharts && Array.isArray(parentSubCharts)) {
          parentSubCharts.length = 0; // Clear the array
        }
        
        // Clear MouseManager references
        const mouseManager = (parentToDelete as any).mouseManager;
        if (mouseManager) {
          if (mouseManager.subCharts && Array.isArray(mouseManager.subCharts)) {
            mouseManager.subCharts.length = 0; // Clear the array
          }
          if (mouseManager.hoveredSubChart) {
            mouseManager.hoveredSubChart = null;
          }
        }
      } catch (e) {
        // Ignore - might not be accessible
      }
    }

    // Clear vertical group reference - surfaces will be cleaned up by delete()
    // SciChartVerticalGroup doesn't have a remove method, so just nullify the reference
    if (this.verticalGroup) {
      this.verticalGroup = null;
    }

    // Clear the panes map WITHOUT calling delete on subsurfaces
    // The parent.delete() will cascade delete all subsurfaces automatically
    this.paneSurfaces.clear();

    // Delete parent surface LAST - this cascades to all subsurfaces
    // Catch "already deleted" errors from SciChart
    try {
      parentToDelete.delete();
    } catch (e: any) {
      // Silently ignore "already deleted" and "dataSeries has been deleted" errors
      const msg = e?.message || '';
      if (!msg.includes('already been deleted') && !msg.includes('dataSeries has been deleted')) {
        console.warn('[DynamicPaneManager] Error deleting parent surface:', e);
      }
    }

    this.sharedWasm = null;
    this.gridRows = 1;
    this.gridCols = 1;
  }
}

