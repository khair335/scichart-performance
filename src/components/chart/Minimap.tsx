// Minimap component - SciChart Overview that controls visible range
import { useEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { SciChartOverview } from 'scichart';
import { LayoutEngine, PaneSurface } from '@/lib/layout-engine';

interface MinimapProps {
  enabled: boolean;
  sourceSeriesId?: string;
  className?: string;
}

export function Minimap({ enabled, sourceSeriesId, className }: MinimapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overviewRef = useRef<SciChartOverview | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  useEffect(() => {
    if (!enabled || !containerRef.current) {
      // Cleanup if disabled
      if (overviewRef.current) {
        try {
          overviewRef.current.delete();
        } catch (e) {
          // Ignore
        }
        overviewRef.current = null;
        setIsInitialized(false);
      }
      return;
    }
    
    let mounted = true;
    
    const initOverview = async () => {
      const state = LayoutEngine.getState();
      if (!state.isInitialized || state.panes.size === 0) {
        setError('No chart loaded');
        return;
      }
      
      // Find source pane - prefer specified series, otherwise use first pane
      let sourcePaneSurface: PaneSurface | null = null;
      
      if (sourceSeriesId) {
        sourcePaneSurface = LayoutEngine.getPaneForSeries(sourceSeriesId);
      }
      
      if (!sourcePaneSurface) {
        // Use first pane
        sourcePaneSurface = state.panes.values().next().value || null;
      }
      
      if (!sourcePaneSurface || sourcePaneSurface.isDeleted) {
        setError('No valid chart surface found');
        return;
      }
      
      try {
        // Clean up previous overview
        if (overviewRef.current) {
          try {
            overviewRef.current.delete();
          } catch (e) {
            // Ignore
          }
          overviewRef.current = null;
        }
        
        if (!containerRef.current || !mounted) return;
        
        // Create overview
        const overview = await SciChartOverview.create(
          sourcePaneSurface.surface,
          containerRef.current,
          {
            theme: {
              type: 'Dark',
              sciChartBackground: '#161a20',
              loadingAnimationBackground: '#161a20',
            },
          }
        );
        
        if (!mounted) {
          overview.delete();
          return;
        }
        
        overviewRef.current = overview;
        setIsInitialized(true);
        setError(null);
        console.log('[Minimap] Overview created successfully');
      } catch (e) {
        console.error('[Minimap] Failed to create overview:', e);
        setError(e instanceof Error ? e.message : 'Failed to create minimap');
      }
    };
    
    // Wait a bit for layout to stabilize
    const timeout = setTimeout(initOverview, 300);
    
    return () => {
      mounted = false;
      clearTimeout(timeout);
      
      if (overviewRef.current) {
        try {
          overviewRef.current.delete();
        } catch (e) {
          // Ignore
        }
        overviewRef.current = null;
      }
    };
  }, [enabled, sourceSeriesId]);
  
  // Re-initialize when layout changes
  useEffect(() => {
    if (!enabled) return;
    
    const unsubscribe = LayoutEngine.subscribe((state) => {
      if (state.isInitialized && !overviewRef.current && containerRef.current) {
        // Reinitialize after layout load
        setIsInitialized(false);
      }
    });
    
    return unsubscribe;
  }, [enabled]);
  
  if (!enabled) return null;
  
  return (
    <div className={cn('relative bg-card border-t border-border', className)}>
      <div 
        ref={containerRef} 
        className="w-full h-full min-h-[60px]"
        style={{ height: '60px' }}
      />
      
      {!isInitialized && !error && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80">
          <span className="text-xs text-muted-foreground">Loading minimap...</span>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-card/80">
          <span className="text-xs text-destructive">{error}</span>
        </div>
      )}
    </div>
  );
}
