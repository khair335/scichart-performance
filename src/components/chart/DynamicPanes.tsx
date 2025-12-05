// Dynamic Panes - Renders chart pane containers based on layout
// Creates the DOM structure needed by ChartEngine

import { useMemo } from 'react';
import type { PlotLayout } from '@/types/layout';
import { cn } from '@/lib/utils';

interface DynamicPanesProps {
  containerId: string;
  layout: PlotLayout;
  className?: string;
}

export function DynamicPanes({ containerId, layout, className }: DynamicPanesProps) {
  // Calculate grid template based on layout
  const gridStyle = useMemo(() => {
    const [rows] = layout.grid;
    const heights = layout.panes.map(p => p.height);
    const totalHeight = heights.reduce((sum, h) => sum + h, 0);
    const gridTemplateRows = heights.map(h => `${(h / totalHeight) * 100}%`).join(' ');
    
    return {
      display: 'grid',
      gridTemplateRows,
      gridTemplateColumns: '1fr',
      height: '100%',
      width: '100%',
    };
  }, [layout]);

  return (
    <div className={cn('relative', className)} style={gridStyle}>
      {layout.panes.map((pane, index) => (
        <div
          key={pane.id}
          className={cn(
            'relative min-h-0',
            index < layout.panes.length - 1 && 'border-b border-border'
          )}
        >
          {/* Pane title overlay */}
          {pane.title && (
            <div className="pane-title">{pane.title}</div>
          )}
          
          {/* SciChart container - this ID is used by ChartEngine */}
          <div
            id={`${containerId}-pane-${pane.id}`}
            className="w-full h-full"
          />
          
          {/* Waiting for data overlay - shown when pane has no renderable series */}
          <WaitingOverlay paneId={pane.id} />
        </div>
      ))}
    </div>
  );
}

// Waiting overlay component
function WaitingOverlay({ paneId }: { paneId: string }) {
  // This could be connected to chart state to show/hide
  // For now, it's hidden by default and can be shown via CSS
  return (
    <div 
      id={`waiting-${paneId}`}
      className="absolute inset-0 flex items-center justify-center bg-card/80 backdrop-blur-sm z-10 hidden"
    >
      <div className="text-center">
        <div className="w-8 h-8 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">Waiting for data...</p>
      </div>
    </div>
  );
}
