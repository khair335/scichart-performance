// DynamicPlotGrid - Renders a CSS Grid of chart panes based on layout JSON
// This component creates the DOM structure that LayoutEngine will populate

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import type { PlotLayoutJSON, PaneConfig } from '@/types/layout';
import { validateLayout } from '@/types/layout';
import { LayoutEngine } from '@/lib/layout-engine';
import { SeriesStore } from '@/lib/series-store';
import { Loader2 } from 'lucide-react';

interface DynamicPlotGridProps {
  layout: PlotLayoutJSON | null;
  onLayoutLoaded?: () => void;
  onError?: (errors: string[]) => void;
  className?: string;
}

interface PaneState {
  hasData: boolean;
  seriesIds: string[];
}

export function DynamicPlotGrid({ layout, onLayoutLoaded, onError, className }: DynamicPlotGridProps) {
  const containerRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [paneStates, setPaneStates] = useState<Map<string, PaneState>>(new Map());
  const [isLoading, setIsLoading] = useState(false);
  const [layoutErrors, setLayoutErrors] = useState<string[]>([]);
  const layoutIdRef = useRef<string | null>(null);
  const isMountedRef = useRef(true);
  
  // Track mount state
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Reset loading state on unmount
      LayoutEngine.resetLoadingState();
    };
  }, []);
  
  // Subscribe to SeriesStore to track when panes have data
  useEffect(() => {
    if (!layout) return;
    
    const unsubscribe = SeriesStore.subscribe((entries) => {
      setPaneStates(prev => {
        const next = new Map(prev);
        let changed = false;
        
        for (const pane of layout.panes) {
          const seriesIds = layout.series
            .filter(s => s.pane === pane.id)
            .map(s => s.series_id);
          
          const hasData = seriesIds.some(id => {
            const entry = entries.get(id);
            return entry && entry.metadata.pointCount > 0;
          });
          
          const current = next.get(pane.id);
          if (!current || current.hasData !== hasData) {
            next.set(pane.id, { hasData, seriesIds });
            changed = true;
          }
        }
        
        return changed ? next : prev;
      });
    });
    
    return unsubscribe;
  }, [layout]);
  
  // Initialize layout when it changes
  useEffect(() => {
    if (!layout) {
      // Dispose existing surfaces when layout is cleared
      LayoutEngine.disposeAllSurfaces();
      layoutIdRef.current = null;
      return;
    }
    
    // Generate a unique ID for this layout load
    const layoutId = `${layout.meta?.name || 'unnamed'}_${Date.now()}`;
    
    // Skip if same layout is already loading/loaded
    if (layoutIdRef.current === layout.meta?.name) {
      return;
    }
    
    // Validate layout
    const validation = validateLayout(layout);
    if (!validation.valid) {
      setLayoutErrors(validation.errors);
      onError?.(validation.errors);
      return;
    }
    
    setLayoutErrors([]);
    setIsLoading(true);
    layoutIdRef.current = layout.meta?.name || layoutId;
    
    // Wait for containers to be rendered
    const initLayout = async () => {
      // Longer delay to ensure DOM is fully ready and sized
      await new Promise(resolve => setTimeout(resolve, 300));
      
      if (!isMountedRef.current) return;
      
      // Collect container refs
      const containers = new Map<string, HTMLDivElement>();
      for (const pane of layout.panes) {
        const container = containerRefs.current.get(pane.id);
        if (container) {
          // Log container dimensions for debugging
          const rect = container.getBoundingClientRect();
          console.log(`[DynamicPlotGrid] Container ${pane.id}: ${rect.width}x${rect.height}`);
          containers.set(pane.id, container);
        } else {
          console.warn(`[DynamicPlotGrid] Container ref not found for pane: ${pane.id}`);
        }
      }
      
      // Load layout into engine
      const success = await LayoutEngine.loadLayout(layout, containers);
      
      if (!isMountedRef.current) return;
      
      setIsLoading(false);
      
      if (success) {
        onLayoutLoaded?.();
        
        // Initialize pane states - check for existing data in SeriesStore
        const allEntries = SeriesStore.getAllEntries();
        const states = new Map<string, PaneState>();
        for (const pane of layout.panes) {
          const seriesIds = layout.series
            .filter(s => s.pane === pane.id)
            .map(s => s.series_id);
          
          // Check if any series already has data
          const hasData = seriesIds.some(id => {
            const entry = allEntries.get(id);
            return entry && entry.metadata.pointCount > 0;
          });
          
          states.set(pane.id, { hasData, seriesIds });
          console.log(`[DynamicPlotGrid] Pane ${pane.id} hasData: ${hasData}, series: ${seriesIds.join(', ')}`);
        }
        setPaneStates(states);
      } else {
        const state = LayoutEngine.getState();
        setLayoutErrors(state.errors);
        onError?.(state.errors);
      }
    };
    
    initLayout();
    
    return () => {
      // Cleanup when layout changes
    };
  }, [layout?.meta?.name]); // Only re-run when layout name changes
  
  // Set container ref
  const setContainerRef = useCallback((paneId: string) => (el: HTMLDivElement | null) => {
    if (el) {
      containerRefs.current.set(paneId, el);
    } else {
      containerRefs.current.delete(paneId);
    }
  }, []);
  
  // No layout state
  if (!layout) {
    return (
      <div className={cn('flex items-center justify-center h-full bg-card', className)}>
        <div className="text-center max-w-md px-6">
          <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center mx-auto mb-4">
            <svg className="w-10 h-10 text-muted-foreground" viewBox="0 0 24 24" fill="none" stroke="currentColor">
              <rect x="3" y="3" width="7" height="7" strokeWidth="2" />
              <rect x="14" y="3" width="7" height="7" strokeWidth="2" />
              <rect x="3" y="14" width="7" height="7" strokeWidth="2" />
              <rect x="14" y="14" width="7" height="7" strokeWidth="2" />
            </svg>
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">No Layout Loaded</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Load a plot layout JSON file to visualize data. Data is being collected in the background.
          </p>
          <p className="text-xs text-muted-foreground">
            Use the toolbar to load a layout file.
          </p>
        </div>
      </div>
    );
  }
  
  // Layout errors
  if (layoutErrors.length > 0) {
    return (
      <div className={cn('flex items-center justify-center h-full bg-card', className)}>
        <div className="text-center max-w-lg px-6">
          <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center mx-auto mb-4">
            <span className="text-destructive text-3xl">!</span>
          </div>
          <h3 className="text-xl font-semibold text-foreground mb-2">Layout Validation Failed</h3>
          <ul className="text-sm text-destructive text-left list-disc list-inside space-y-1">
            {layoutErrors.map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
        </div>
      </div>
    );
  }
  
  const [rows, cols] = layout.grid;
  
  return (
    <div 
      className={cn('h-full w-full relative', className)}
      style={{
        display: 'grid',
        gridTemplateRows: `repeat(${rows}, 1fr)`,
        gridTemplateColumns: `repeat(${cols}, 1fr)`,
        gap: '1px',
        backgroundColor: 'hsl(var(--border))',
      }}
    >
      {layout.panes.map((pane) => (
        <PaneContainer
          key={pane.id}
          pane={pane}
          setRef={setContainerRef(pane.id)}
          isLoading={isLoading}
          state={paneStates.get(pane.id)}
          layout={layout}
        />
      ))}
    </div>
  );
}

// Individual pane container
interface PaneContainerProps {
  pane: PaneConfig;
  setRef: (el: HTMLDivElement | null) => void;
  isLoading: boolean;
  state?: PaneState;
  layout: PlotLayoutJSON;
}

function PaneContainer({ pane, setRef, isLoading, state, layout }: PaneContainerProps) {
  const seriesForPane = layout.series.filter(s => s.pane === pane.id);
  const hasSeriesDefinitions = seriesForPane.length > 0;
  const hasData = state?.hasData ?? false;
  const showWaitingForData = !isLoading && hasSeriesDefinitions && !hasData;
  
  return (
    <div
      style={{
        gridRow: `${pane.row + 1} / span ${pane.height || 1}`,
        gridColumn: `${pane.col + 1} / span ${pane.width || 1}`,
      }}
      className="relative bg-card overflow-hidden flex flex-col"
    >
      {/* Pane title */}
      {pane.title && (
        <div className="absolute top-2 left-3 z-20 text-xs font-medium text-muted-foreground bg-card/80 px-2 py-0.5 rounded pointer-events-none">
          {pane.title}
        </div>
      )}
      
      {/* Chart container - takes all available space */}
      <div 
        ref={setRef}
        className="flex-1 w-full relative z-0"
        style={{ minHeight: '100px' }}
        data-pane-id={pane.id}
      />
      
      {/* Loading overlay */}
      {isLoading && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/90 z-30">
          <Loader2 className="w-6 h-6 animate-spin text-primary" />
        </div>
      )}
      
      {/* Waiting for data overlay */}
      {showWaitingForData && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-card/95 z-10">
          <Loader2 className="w-5 h-5 animate-spin text-muted-foreground mb-2" />
          <span className="text-xs text-muted-foreground">Waiting for data...</span>
          <span className="text-xs text-muted-foreground/70 mt-1">
            {seriesForPane.length} series pending
          </span>
        </div>
      )}
      
      {/* PnL indicator */}
      {pane.isPnL && (
        <div className="absolute top-2 right-3 z-20 text-xs font-medium text-green-500 bg-green-500/10 px-2 py-0.5 rounded border border-green-500/20 pointer-events-none">
          PnL
        </div>
      )}
      
      {/* Bar/OHLC indicator */}
      {pane.isBar && (
        <div className="absolute top-2 right-3 z-20 text-xs font-medium text-blue-500 bg-blue-500/10 px-2 py-0.5 rounded border border-blue-500/20 pointer-events-none">
          OHLC
        </div>
      )}
    </div>
  );
}
