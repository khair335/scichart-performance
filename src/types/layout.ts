// Plot Layout Type Definitions
// Defines the structure for dynamic layout-driven chart creation

export interface PlotLayout {
  layout_mode: 'multi_surface';
  grid: [number, number]; // [rows, cols]
  minimap: {
    source: {
      series_id: string;
      yField?: string;
    };
  };
  panes: PaneDefinition[];
  series: SeriesAssignment[];
  strategy_markers?: {
    exclude_panes?: string[];
    include_panes?: string[];
  };
  meta?: {
    version: string;
    name?: string;
    description?: string;
  };
}

export interface PaneDefinition {
  id: string;
  row: number;
  col: number;
  height: number;
  width: number;
  title?: string;
  overlays?: {
    hline?: HorizontalLine[];
    vline?: VerticalLine[];
  };
}

export interface HorizontalLine {
  id: string;
  y: number;
  label: string;
  color?: string;
  style?: {
    strokeDashArray?: number[];
    strokeThickness?: number;
  };
}

export interface VerticalLine {
  id: string;
  x: number;
  label: string;
  color?: string;
  style?: {
    strokeDashArray?: number[];
    strokeThickness?: number;
  };
}

export interface SeriesAssignment {
  series_id: string;
  pane: string; // Pane ID
  type: SeriesType;
  color?: string;
  strokeThickness?: number;
  visible?: boolean;
}

export type SeriesType = 
  | 'FastLineRenderableSeries'
  | 'FastCandlestickRenderableSeries'
  | 'FastMountainRenderableSeries'
  | 'XyScatterRenderableSeries';

// Default 2x1 layout (tick pane + OHLC pane)
export const defaultLayout: PlotLayout = {
  layout_mode: 'multi_surface',
  grid: [2, 1], // 2 rows, 1 column
  minimap: {
    source: {
      series_id: '*:ticks',
      yField: 'price',
    },
  },
  panes: [
    {
      id: 'tick-pane',
      row: 0,
      col: 0,
      height: 60,
      width: 100,
      title: 'Tick Price & Indicators',
    },
    {
      id: 'ohlc-pane',
      row: 1,
      col: 0,
      height: 40,
      width: 100,
      title: 'OHLC Candlesticks',
    },
  ],
  series: [
    {
      series_id: '*:ticks',
      pane: 'tick-pane',
      type: 'FastLineRenderableSeries',
      color: '#50C7E0',
      strokeThickness: 1,
    },
    {
      series_id: '*:sma_*',
      pane: 'tick-pane',
      type: 'FastLineRenderableSeries',
      color: '#F48420',
      strokeThickness: 2,
    },
    {
      series_id: '*:ohlc_time:*',
      pane: 'ohlc-pane',
      type: 'FastCandlestickRenderableSeries',
    },
  ],
  meta: {
    version: '1.0.0',
    name: 'Default Layout',
  },
};

// Parse and validate layout JSON
export function parseLayout(json: unknown): PlotLayout {
  const obj = json as Record<string, unknown>;
  
  if (!obj || typeof obj !== 'object') {
    throw new Error('Invalid layout: must be an object');
  }

  // Validate required fields
  if (!obj.grid || !Array.isArray(obj.grid) || obj.grid.length !== 2) {
    throw new Error('Invalid layout: grid must be [rows, cols]');
  }

  if (!obj.panes || !Array.isArray(obj.panes) || obj.panes.length === 0) {
    throw new Error('Invalid layout: panes array required');
  }

  // Use defaults for optional fields
  const layout: PlotLayout = {
    layout_mode: 'multi_surface',
    grid: obj.grid as [number, number],
    minimap: (obj.minimap as PlotLayout['minimap']) || { source: { series_id: '*:ticks' } },
    panes: obj.panes as PaneDefinition[],
    series: (obj.series as SeriesAssignment[]) || [],
    strategy_markers: obj.strategy_markers as PlotLayout['strategy_markers'],
    meta: obj.meta as PlotLayout['meta'],
  };

  return layout;
}

// Match series_id against pattern (supports wildcards)
export function matchesSeriesPattern(seriesId: string, pattern: string): boolean {
  // Convert pattern to regex
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // Escape regex special chars except *
    .replace(/\*/g, '.*'); // Convert * to .*
  
  const regex = new RegExp(`^${regexPattern}$`);
  return regex.test(seriesId);
}

// Find the pane assignment for a series
export function findPaneForSeries(layout: PlotLayout, seriesId: string): string | null {
  for (const assignment of layout.series) {
    if (matchesSeriesPattern(seriesId, assignment.series_id)) {
      return assignment.pane;
    }
  }
  return null;
}

// Get series config for a series_id
export function getSeriesConfig(layout: PlotLayout, seriesId: string): SeriesAssignment | null {
  for (const assignment of layout.series) {
    if (matchesSeriesPattern(seriesId, assignment.series_id)) {
      return assignment;
    }
  }
  return null;
}
