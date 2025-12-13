/**
 * Plot Layout JSON Structure
 * Based on client requirements for dynamic grid-based chart layouts
 */

export interface PlotLayout {
  layout_mode: 'multi_surface';
  grid: [number, number]; // [M, N] where M = number of rows, N = number of columns (like a matrix). e.g., [2, 3] = 2 rows × 3 columns
  min_height?: number; // Minimum height in pixels for chart container. If 0 or not set, fits to page height. If set and > page height, allows scrolling.
  minimap?: {
    source: {
      series_id: string;
      yField: string;
    };
  };
  panes: PaneConfig[];
  series: SeriesAssignment[];
  strategy_markers?: StrategyMarkersConfig;
  xAxis?: {
    defaultRange?: {
      mode: 'lastMinutes' | 'lastHours' | 'entireSession' | 'session' | 'custom';
      value?: number; // Minutes or hours depending on mode, or custom range [min, max] in ms
      customRange?: [number, number]; // [min, max] in milliseconds (Unix timestamp)
    };
  };
  meta?: {
    version: string;
  };
}

export interface PaneConfig {
  id: string;
  row: number;
  col: number;
  height: number;
  width: number;
  title?: string; // Plot title
  overlays?: {
    hline?: HLineConfig[];
    vline?: VLineConfig[];
  };
}

export interface HLineConfig {
  id: string;
  y: number;
  label: string;
  style?: {
    strokeDashArray?: number[];
    stroke?: string;
    strokeThickness?: number;
  };
}

export interface VLineConfig {
  id: string;
  x: number;
  label: string;
  style?: {
    strokeDashArray?: number[];
    stroke?: string;
    strokeThickness?: number;
  };
}

export interface SeriesAssignment {
  series_id: string;
  pane: string; // Pane ID
  type: 'FastLineRenderableSeries' | 'FastCandlestickRenderableSeries' | 'FastMountainRenderableSeries';
  style?: {
    stroke?: string; // Line color
    strokeThickness?: number; // Line width
    fill?: string; // Fill color (for mountain series)
    pointMarker?: boolean; // Show point markers
  };
}

export interface StrategyMarkersConfig {
  // Which panes should show strategy markers
  exclude_panes?: string[]; // e.g., ['pnl-pane', 'bar-pane']
  // Or explicitly list which panes should show markers
  include_panes?: string[];
}

/**
 * Parsed layout with computed information
 */
export interface ParsedLayout {
  layout: PlotLayout;
  paneMap: Map<string, PaneConfig>; // pane.id -> PaneConfig
  seriesToPaneMap: Map<string, string>; // series_id -> pane.id
  paneToSeriesMap: Map<string, string[]>; // pane.id -> series_id[]
  strategyMarkerPanes: Set<string>; // pane.id[] that should show strategy markers
  minimapSourceSeries?: string;
  xAxisDefaultRange?: PlotLayout['xAxis']['defaultRange']; // Default X-axis range from layout
}

/**
 * Validation errors collection
 */
export interface LayoutValidationErrors {
  errors: string[];
  warnings: string[];
}

/**
 * Parse and validate plot layout JSON
 * Enhanced validation per Requirement 7.2
 */
export function parsePlotLayout(json: any, collectErrors?: (errors: LayoutValidationErrors) => void): ParsedLayout {
  const layout = json as PlotLayout;
  const validationErrors: LayoutValidationErrors = { errors: [], warnings: [] };
  
  // Validate required fields
  if (!layout.layout_mode || layout.layout_mode !== 'multi_surface') {
    const error = 'Invalid layout_mode: must be "multi_surface"';
    validationErrors.errors.push(error);
    throw new Error(error);
  }
  
  if (!layout.grid || !Array.isArray(layout.grid) || layout.grid.length !== 2) {
    const error = 'Invalid grid: must be [rows, cols] array';
    validationErrors.errors.push(error);
    throw new Error(error);
  }
  
  const [gridRows, gridCols] = layout.grid;
  if (!Number.isInteger(gridRows) || !Number.isInteger(gridCols) || gridRows < 1 || gridCols < 1) {
    const error = `Invalid grid dimensions: rows and cols must be positive integers, got [${gridRows}, ${gridCols}]`;
    validationErrors.errors.push(error);
    throw new Error(error);
  }
  
  if (!layout.panes || !Array.isArray(layout.panes)) {
    const error = 'Invalid panes: must be an array';
    validationErrors.errors.push(error);
    throw new Error(error);
  }
  
  if (!layout.series || !Array.isArray(layout.series)) {
    const error = 'Invalid series: must be an array';
    validationErrors.errors.push(error);
    throw new Error(error);
  }
  
  // Build maps for efficient lookup
  const paneMap = new Map<string, PaneConfig>();
  const seriesToPaneMap = new Map<string, string>();
  const paneToSeriesMap = new Map<string, string[]>();
  const strategyMarkerPanes = new Set<string>();
  const paneIds = new Set<string>(); // Track for duplicate detection
  
  // Index panes with validation
  for (let i = 0; i < layout.panes.length; i++) {
    const pane = layout.panes[i];
    
    // Validate pane structure
    if (!pane.id || typeof pane.id !== 'string') {
      validationErrors.errors.push(`Pane at index ${i}: missing or invalid 'id' field`);
      continue;
    }
    
    // Check for duplicate pane IDs (Requirement 7.2)
    if (paneIds.has(pane.id)) {
      validationErrors.errors.push(`Duplicate pane ID: "${pane.id}"`);
      continue; // Skip duplicate, but continue validation
    }
    paneIds.add(pane.id);
    
    // Validate pane position (Requirement 7.2: rows/cols match grid definition)
    if (!Number.isInteger(pane.row) || !Number.isInteger(pane.col)) {
      validationErrors.errors.push(`Pane "${pane.id}": row and col must be integers`);
      continue;
    }
    
    if (pane.row < 0 || pane.row >= gridRows) {
      validationErrors.errors.push(`Pane "${pane.id}": row ${pane.row} is outside grid bounds [0, ${gridRows - 1}]`);
      continue;
    }
    
    if (pane.col < 0 || pane.col >= gridCols) {
      validationErrors.errors.push(`Pane "${pane.id}": col ${pane.col} is outside grid bounds [0, ${gridCols - 1}]`);
      continue;
    }
    
    // Validate pane dimensions
    if (!Number.isInteger(pane.height) || !Number.isInteger(pane.width) || pane.height < 1 || pane.width < 1) {
      validationErrors.errors.push(`Pane "${pane.id}": height and width must be positive integers`);
      continue;
    }
    
    // Validate pane doesn't overflow grid
    if (pane.row + pane.height > gridRows) {
      validationErrors.errors.push(`Pane "${pane.id}": extends beyond grid rows (row ${pane.row} + height ${pane.height} > ${gridRows})`);
      continue;
    }
    
    if (pane.col + pane.width > gridCols) {
      validationErrors.errors.push(`Pane "${pane.id}": extends beyond grid cols (col ${pane.col} + width ${pane.width} > ${gridCols})`);
      continue;
    }
    
    // Validate overlays (Requirement 7.2: validate overlay values)
    if (pane.overlays) {
      if (pane.overlays.hline) {
        if (!Array.isArray(pane.overlays.hline)) {
          validationErrors.errors.push(`Pane "${pane.id}": overlays.hline must be an array`);
        } else {
          pane.overlays.hline.forEach((hline, hIdx) => {
            if (!hline.id || typeof hline.id !== 'string') {
              validationErrors.errors.push(`Pane "${pane.id}": overlays.hline[${hIdx}]: missing or invalid 'id'`);
            }
            if (typeof hline.y !== 'number' || !Number.isFinite(hline.y)) {
              validationErrors.errors.push(`Pane "${pane.id}": overlays.hline[${hIdx}]: 'y' must be a finite number`);
            }
            if (!hline.label || typeof hline.label !== 'string') {
              validationErrors.warnings.push(`Pane "${pane.id}": overlays.hline[${hIdx}]: missing 'label' (optional but recommended)`);
            }
          });
        }
      }
      
      if (pane.overlays.vline) {
        if (!Array.isArray(pane.overlays.vline)) {
          validationErrors.errors.push(`Pane "${pane.id}": overlays.vline must be an array`);
        } else {
          pane.overlays.vline.forEach((vline, vIdx) => {
            if (!vline.id || typeof vline.id !== 'string') {
              validationErrors.errors.push(`Pane "${pane.id}": overlays.vline[${vIdx}]: missing or invalid 'id'`);
            }
            if (typeof vline.x !== 'number' || !Number.isFinite(vline.x)) {
              validationErrors.errors.push(`Pane "${pane.id}": overlays.vline[${vIdx}]: 'x' must be a finite number`);
            }
            if (!vline.label || typeof vline.label !== 'string') {
              validationErrors.warnings.push(`Pane "${pane.id}": overlays.vline[${vIdx}]: missing 'label' (optional but recommended)`);
            }
          });
        }
      }
    }
    
    paneMap.set(pane.id, pane);
    paneToSeriesMap.set(pane.id, []);
  }
  
  // Validate series assignments (Requirement 7.2: validate all series reference valid panes)
  for (let i = 0; i < layout.series.length; i++) {
    const seriesAssignment = layout.series[i];
    
    if (!seriesAssignment.series_id || typeof seriesAssignment.series_id !== 'string') {
      validationErrors.errors.push(`Series at index ${i}: missing or invalid 'series_id'`);
      continue;
    }
    
    if (!seriesAssignment.pane || typeof seriesAssignment.pane !== 'string') {
      validationErrors.errors.push(`Series "${seriesAssignment.series_id}": missing or invalid 'pane' field`);
      continue;
    }
    
    if (!paneMap.has(seriesAssignment.pane)) {
      validationErrors.errors.push(`Series "${seriesAssignment.series_id}": assigned to unknown pane "${seriesAssignment.pane}"`);
      continue;
    }
    
    if (!['FastLineRenderableSeries', 'FastCandlestickRenderableSeries', 'FastMountainRenderableSeries', 'FastOhlcRenderableSeries'].includes(seriesAssignment.type)) {
      validationErrors.errors.push(`Series "${seriesAssignment.series_id}": invalid type "${seriesAssignment.type}"`);
      continue;
    }
    
    seriesToPaneMap.set(seriesAssignment.series_id, seriesAssignment.pane);
    const paneSeries = paneToSeriesMap.get(seriesAssignment.pane) || [];
    paneSeries.push(seriesAssignment.series_id);
    paneToSeriesMap.set(seriesAssignment.pane, paneSeries);
  }
  
  // Validate minimap source series if specified
  if (layout.minimap?.source) {
    if (!layout.minimap.source.series_id || typeof layout.minimap.source.series_id !== 'string') {
      validationErrors.errors.push('Minimap source.series_id is required and must be a string');
    } else if (!seriesToPaneMap.has(layout.minimap.source.series_id)) {
      validationErrors.warnings.push(`Minimap source series "${layout.minimap.source.series_id}" is not assigned to any pane`);
    }
  }
  
  // Emit validation errors/warnings if callback provided
  if (collectErrors && (validationErrors.errors.length > 0 || validationErrors.warnings.length > 0)) {
    collectErrors(validationErrors);
  }
  
  // If there are critical errors, throw
  if (validationErrors.errors.length > 0) {
    throw new Error(`Layout validation failed:\n${validationErrors.errors.join('\n')}`);
  }
  
  // Index series assignments
  for (const seriesAssignment of layout.series) {
    if (!paneMap.has(seriesAssignment.pane)) {
      console.warn(`[PlotLayout] Series ${seriesAssignment.series_id} assigned to unknown pane: ${seriesAssignment.pane}`);
      continue;
    }
    
    seriesToPaneMap.set(seriesAssignment.series_id, seriesAssignment.pane);
    const paneSeries = paneToSeriesMap.get(seriesAssignment.pane) || [];
    paneSeries.push(seriesAssignment.series_id);
    paneToSeriesMap.set(seriesAssignment.pane, paneSeries);
  }
  
  // Determine which panes should show strategy markers
  if (layout.strategy_markers) {
    if (layout.strategy_markers.include_panes) {
      // Explicitly include these panes
      for (const paneId of layout.strategy_markers.include_panes) {
        if (paneMap.has(paneId)) {
          strategyMarkerPanes.add(paneId);
        }
      }
    } else {
      // Include all panes except excluded ones
      const excludeSet = new Set(layout.strategy_markers.exclude_panes || []);
      for (const paneId of paneMap.keys()) {
        if (!excludeSet.has(paneId)) {
          strategyMarkerPanes.add(paneId);
        }
      }
    }
  } else {
    // Default: all panes except PnL and bar plots
    for (const pane of layout.panes) {
      const paneSeries = paneToSeriesMap.get(pane.id) || [];
      const hasPnL = paneSeries.some(sid => sid.includes(':strategy:') && sid.includes(':pnl'));
      const hasBar = paneSeries.some(sid => sid.includes(':ohlc_'));
      
      if (!hasPnL && !hasBar) {
        strategyMarkerPanes.add(pane.id);
      }
    }
  }
  
  return {
    layout,
    paneMap,
    seriesToPaneMap,
    paneToSeriesMap,
    strategyMarkerPanes,
    minimapSourceSeries: layout.minimap?.source.series_id,
    xAxisDefaultRange: layout.xAxis?.defaultRange,
  };
}

/**
 * Get default layout (1x1 with tick and OHLC)
 */
export function getDefaultLayout(): PlotLayout {
  return {
    layout_mode: 'multi_surface',
    grid: [2, 1], // 2 rows, 1 column
    panes: [
      {
        id: 'tick-pane',
        row: 0,
        col: 0,
        height: 1,
        width: 1,
        title: 'Tick Price & Indicators',
      },
      {
        id: 'ohlc-pane',
        row: 1,
        col: 0,
        height: 1,
        width: 1,
        title: 'OHLC Candlesticks',
      },
    ],
    series: [],
    strategy_markers: {
      exclude_panes: ['ohlc-pane'], // Exclude bar plots by default
    },
  };
}

