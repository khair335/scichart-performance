// Strategy Markers Types - Buy/Sell signals and custom annotations

export type MarkerType = 'buy' | 'sell' | 'entry' | 'exit' | 'stop' | 'target' | 'custom';

export interface StrategyMarker {
  id: string;
  type: MarkerType;
  timestamp: number; // ms
  price: number;
  label?: string;
  color?: string;
  size?: number;
  tooltip?: string;
  metadata?: Record<string, unknown>;
}

export interface MarkerStyle {
  buy: {
    color: string;
    shape: 'triangle-up' | 'arrow-up' | 'circle';
    size: number;
  };
  sell: {
    color: string;
    shape: 'triangle-down' | 'arrow-down' | 'circle';
    size: number;
  };
  entry: {
    color: string;
    shape: 'diamond' | 'square';
    size: number;
  };
  exit: {
    color: string;
    shape: 'diamond' | 'square';
    size: number;
  };
  stop: {
    color: string;
    shape: 'cross' | 'x';
    size: number;
  };
  target: {
    color: string;
    shape: 'star' | 'circle';
    size: number;
  };
  custom: {
    color: string;
    shape: 'circle';
    size: number;
  };
}

export const DEFAULT_MARKER_STYLES: MarkerStyle = {
  buy: {
    color: '#26a69a',
    shape: 'triangle-up',
    size: 12,
  },
  sell: {
    color: '#ef5350',
    shape: 'triangle-down',
    size: 12,
  },
  entry: {
    color: '#42a5f5',
    shape: 'diamond',
    size: 10,
  },
  exit: {
    color: '#ab47bc',
    shape: 'diamond',
    size: 10,
  },
  stop: {
    color: '#ff7043',
    shape: 'cross',
    size: 10,
  },
  target: {
    color: '#66bb6a',
    shape: 'star',
    size: 10,
  },
  custom: {
    color: '#78909c',
    shape: 'circle',
    size: 8,
  },
};
