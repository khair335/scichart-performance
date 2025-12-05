// Layout JSON Schema Types - Single Source of Truth for plotting

export type RenderableSeriesType = 
  | 'FastLineRenderableSeries' 
  | 'FastCandlestickRenderableSeries' 
  | 'FastMountainRenderableSeries';

export interface HLineOverlay {
  id: string;
  y: number;
  label?: string;
  color?: string;
  strokeThickness?: number;
  style?: {
    strokeDashArray?: number[];
  };
}

export interface VLineOverlay {
  id: string;
  x: number; // timestamp ms
  label?: string;
  color?: string;
  strokeThickness?: number;
  style?: {
    strokeDashArray?: number[];
  };
}

export interface PaneOverlays {
  hline?: HLineOverlay[];
  vline?: VLineOverlay[];
}

export interface SeriesConfig {
  series_id: string;
  pane: string;
  type: RenderableSeriesType;
  color?: string;
  strokeThickness?: number;
  visible?: boolean;
}

export interface PaneConfig {
  id: string;
  title?: string;
  row: number;
  col: number;
  height?: number; // Grid row span (default 1)
  width?: number;  // Grid col span (default 1)
  overlays?: PaneOverlays;
  isPnL?: boolean; // Marks this as PnL-only pane
  isBar?: boolean; // Marks this as bar pane (OHLC)
}

export interface MinimapConfig {
  source: {
    series_id: string;
    yField?: string;
  };
}

export interface StrategyMarkersConfig {
  include_panes?: string[]; // Only show in these panes
  exclude_panes?: string[]; // Exclude from these panes (default: PnL + bar panes)
}

export interface PlotLayoutJSON {
  layout_mode: 'multi_surface' | 'single_surface';
  grid: [number, number]; // [rows, cols]
  panes: PaneConfig[];
  series: SeriesConfig[];
  minimap?: MinimapConfig;
  strategy_markers?: StrategyMarkersConfig;
  meta?: {
    version?: string;
    name?: string;
    description?: string;
    created?: string;
  };
}

// UI Config JSON Schema
export interface UIConfig {
  transport: {
    wsUrl: string;
    binary: boolean;
    useWorker: boolean;
  };
  ingest: {
    targetTransferHz: number;
    maxPointsPerBatch: number;
  };
  uiDrain: {
    maxBatchesPerFrame: number;
    maxMsPerFrame: number;
  };
  data: {
    registry: {
      enabled: boolean;
      maxRows: number;
    };
    buffers: {
      pointsPerSeries: number;  // Default preallocation (1,000,000)
      maxPointsTotal: number;   // Global cap (10,000,000)
    };
  };
  performance: {
    targetFPS: number;
    batchSize: number;
    downsampleRatio: number;
    maxAutoTicks: number;
  };
  chart: {
    separateXAxes: boolean;
    autoScroll: boolean;
    autoScrollThreshold: number;
    timezone: string;
  };
  dataCollection: {
    continueWhenPaused: boolean;
    backgroundBufferSize: number;
  };
  minimap: {
    enabled: boolean;
    overlay: boolean;
    liveWindowMs: number;
  };
  layout?: {
    preserveViewportOnReload: boolean;
    reuseXAxis: boolean;
    defaultLayout?: string; // Path to default layout JSON
  };
  ui: {
    hud?: {
      visible: boolean;
      mode: 'minimal' | 'full';
      autoHideMs?: number;
    };
    toolbar?: {
      autoHide: boolean;
      opacityIdle?: number;
    };
    theme: {
      default: 'dark' | 'light';
      allowToggle: boolean;
    };
  };
  logging?: {
    level: 'debug' | 'info' | 'warn' | 'error';
    includeStatus: boolean;
    includeEvents: boolean;
  };
}

// Validation functions
export function validateLayout(layout: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  
  if (!layout || typeof layout !== 'object') {
    return { valid: false, errors: ['Layout must be an object'] };
  }
  
  const l = layout as Record<string, unknown>;
  
  // Required fields
  if (!l.grid || !Array.isArray(l.grid) || l.grid.length !== 2) {
    errors.push('grid must be [rows, cols] array');
  }
  
  if (!l.panes || !Array.isArray(l.panes) || l.panes.length === 0) {
    errors.push('panes array is required and must not be empty');
  }
  
  if (!l.series || !Array.isArray(l.series)) {
    errors.push('series array is required');
  }
  
  // Validate pane IDs are unique
  if (Array.isArray(l.panes)) {
    const paneIds = new Set<string>();
    for (const pane of l.panes) {
      if (typeof pane !== 'object' || !pane) continue;
      const p = pane as Record<string, unknown>;
      if (!p.id) {
        errors.push('Each pane must have an id');
      } else if (paneIds.has(p.id as string)) {
        errors.push(`Duplicate pane id: ${p.id}`);
      } else {
        paneIds.add(p.id as string);
      }
      
      if (typeof p.row !== 'number' || typeof p.col !== 'number') {
        errors.push(`Pane ${p.id || 'unknown'} must have row and col numbers`);
      }
    }
    
    // Validate series reference valid panes
    if (Array.isArray(l.series)) {
      for (const ser of l.series) {
        if (typeof ser !== 'object' || !ser) continue;
        const s = ser as Record<string, unknown>;
        if (!s.series_id) {
          errors.push('Each series must have a series_id');
        }
        if (!s.pane) {
          errors.push(`Series ${s.series_id || 'unknown'} must have a pane assignment`);
        } else if (!paneIds.has(s.pane as string)) {
          errors.push(`Series ${s.series_id} references unknown pane: ${s.pane}`);
        }
      }
    }
  }
  
  // Validate minimap if present
  if (l.minimap) {
    const mm = l.minimap as Record<string, unknown>;
    if (!mm.source || typeof mm.source !== 'object') {
      errors.push('minimap.source is required');
    } else {
      const src = mm.source as Record<string, unknown>;
      if (!src.series_id) {
        errors.push('minimap.source.series_id is required');
      }
    }
  }
  
  return { valid: errors.length === 0, errors };
}

// Default empty layout state
export const NO_LAYOUT_STATE = {
  message: 'No layout loaded. Load a plot layout JSON to visualize data.',
  showRegistry: true,
};
