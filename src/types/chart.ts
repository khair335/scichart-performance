// Chart-related type definitions

export interface ChartConfig {
  wsUrl: string;
  timezone: string;
  theme: 'dark' | 'light';
  performance: {
    maxTickPoints: number;
    maxSmaPoints: number;
    maxBarPoints: number;
    fifoEnabled: boolean;
  };
  minimap: {
    enabled: boolean;
    height: number;
  };
  defaultLayout: LayoutConfig;
}

export interface LayoutConfig {
  panes: PaneConfig[];
  minimapSourceSeries: string;
}

export interface PaneConfig {
  id: string;
  title: string;
  heightRatio: number;
  series: SeriesConfig[];
  overlays?: OverlayConfig[];
}

export interface SeriesConfig {
  seriesId: string;
  type: 'line' | 'ohlc' | 'pnl';
  color?: string;
  strokeThickness?: number;
  visible?: boolean;
}

export interface OverlayConfig {
  type: 'hline';
  value: number;
  color: string;
  label?: string;
}

export interface DataClockState {
  currentMs: number;
  formattedTime: string;
}

export interface ChartState {
  isLive: boolean;
  isPaused: boolean;
  fps: number;
  dataClockMs: number;
}

// Default configuration
export const defaultChartConfig: ChartConfig = {
  wsUrl: 'ws://127.0.0.1:8765',
  timezone: 'America/Chicago',
  theme: 'dark',
  performance: {
    maxTickPoints: 3_000_000,
    maxSmaPoints: 3_000_000,
    maxBarPoints: 1_000_000,
    fifoEnabled: true,
  },
  minimap: {
    enabled: false, // Disabled by default for better FPS - user can enable via toolbar
    height: 60,
  },
  defaultLayout: {
    panes: [
      {
        id: 'tick-pane',
        title: 'Tick Price & Indicators',
        heightRatio: 0.6,
        series: [
          { seriesId: 'ticks', type: 'line', color: 'hsl(187 70% 55%)' },
          { seriesId: 'sma_10', type: 'line', color: 'hsl(28 90% 55%)' },
        ],
      },
      {
        id: 'ohlc-pane',
        title: 'OHLC Candlesticks',
        heightRatio: 0.4,
        series: [
          { seriesId: 'ohlc_time', type: 'ohlc' },
        ],
      },
    ],
    minimapSourceSeries: 'ticks',
  },
};
