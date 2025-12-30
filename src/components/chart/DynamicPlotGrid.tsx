/**
 * DynamicPlotGrid Component
 * Renders a dynamic MxN grid of chart panes based on plot layout
 * Supports resizable panes using react-resizable-panels
 */

import { useEffect, useRef, useState, useCallback } from 'react';
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from '@/components/ui/resizable';
import type { ParsedLayout, PaneConfig } from '@/types/plot-layout';

interface DynamicPlotGridProps {
  layout: ParsedLayout | null;
  onPaneReady?: (paneId: string, containerId: string) => void;
  onPaneDestroyed?: (paneId: string) => void;
  onGridReady?: (parentContainerId: string, rows: number, cols: number) => void;
  className?: string;
  resizable?: boolean; // Enable/disable resizable panes
}

export function DynamicPlotGrid({
  layout,
  onPaneReady,
  onPaneDestroyed,
  onGridReady,
  className = '',
  resizable = true,
}: DynamicPlotGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const containerIdsRef = useRef<Map<string, string>>(new Map());
  const notifiedPanesRef = useRef<Set<string>>(new Set());
  const gridReadyNotifiedRef = useRef<boolean>(false);
  const lastLayoutIdRef = useRef<string | null>(null);
  const lastMinHeightRef = useRef<number | undefined>(undefined);
  const [gridStyle, setGridStyle] = useState<React.CSSProperties>({});
  
  // Calculate hasMinHeight once for consistent use - extract value for dependency tracking
  const minHeight = layout?.layout.min_height;
  const hasMinHeight = minHeight !== undefined && minHeight > 0;

  // Keep container sizing in sync with layout min_height even when the layout object is reused
  // Use minHeight as direct dependency to catch all changes
  useEffect(() => {
    const minHeightValue = minHeight ?? 0;
    const minHeightActive = minHeightValue > 0;

    // Detect if min_height actually changed
    if (lastMinHeightRef.current !== minHeightValue) {
      console.log('[DynamicPlotGrid] min_height changed:', lastMinHeightRef.current, '->', minHeightValue);
      lastMinHeightRef.current = minHeightValue;
    }

    // Update state-driven grid styles so React re-renders when min_height changes
    setGridStyle(prev => ({
      ...prev,
      height: minHeightActive ? 'auto' : '100%',
      minHeight: minHeightActive ? `${minHeightValue}px` : undefined,
      overflow: minHeightActive ? 'visible' : 'hidden',
    }));

    // Apply imperative styles to parent/grid to cover cases where the layout reference doesn't change
    if (parentRef.current) {
      parentRef.current.style.minHeight = minHeightActive ? `${minHeightValue}px` : '';
      parentRef.current.style.height = minHeightActive ? 'auto' : '';
      parentRef.current.style.overflow = minHeightActive ? 'visible' : '';
      parentRef.current.style.overflowX = minHeightActive ? 'hidden' : '';
    }

    if (gridRef.current) {
      gridRef.current.style.overflow = minHeightActive ? 'visible' : '';
      gridRef.current.style.overflowX = minHeightActive ? 'hidden' : '';
    }
  }, [minHeight]);

  useEffect(() => {
    if (!layout) {
      // No layout - clear grid
      if (gridRef.current) {
        gridRef.current.innerHTML = '';
      }
      containerIdsRef.current.clear();
      notifiedPanesRef.current.clear(); // CRITICAL: Clear notified panes
      gridReadyNotifiedRef.current = false;
      lastLayoutIdRef.current = null;
      // Reset parent container styles
      if (parentRef.current) {
        parentRef.current.style.minHeight = '';
      }
      return;
    }

    // Grid format: [M, N] where M = rows, N = columns (like a matrix)
    const [rows, cols] = layout.layout.grid;

    // Create a layout ID to detect changes - include series assignments to detect layout changes
    const layoutId = JSON.stringify({
      panes: layout.layout.panes.map(p => ({ id: p.id, row: p.row, col: p.col })),
      series: layout.layout.series?.map(s => ({ series_id: s.series_id, pane: s.pane })) || [],
      grid: layout.layout.grid,
      min_height: layout.layout.min_height
    });

    // Reset and clear everything if layout changed
    if (lastLayoutIdRef.current !== layoutId) {
      console.log('[DynamicPlotGrid] Layout changed, clearing all panes and resetting state');
      
      // CRITICAL: Clear the grid completely for new layout
      if (gridRef.current) {
        gridRef.current.innerHTML = '';
      }
      
      // Notify about destroyed panes BEFORE clearing tracking
      if (onPaneDestroyed) {
        for (const paneId of containerIdsRef.current.keys()) {
          onPaneDestroyed(paneId);
        }
      }
      
      // Clear all tracking refs
      containerIdsRef.current.clear();
      notifiedPanesRef.current.clear();
      gridReadyNotifiedRef.current = false;
      lastLayoutIdRef.current = layoutId;
    }

    // Set CSS Grid layout - use pre-calculated hasMinHeight and minHeight
    setGridStyle({
      display: 'grid',
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      width: '100%',
      height: hasMinHeight ? 'auto' : '100%',
      minHeight: hasMinHeight ? `${minHeight}px` : undefined,
      gap: '1px',
      overflow: hasMinHeight ? 'visible' : 'hidden', // Allow scrolling when min_height is set
    });
    
    // Apply min-height to parent container (also done in separate useEffect for reliability)
    if (parentRef.current) {
      if (hasMinHeight && minHeight) {
        console.log('[DynamicPlotGrid] Setting min-height in main effect:', minHeight);
        parentRef.current.style.minHeight = `${minHeight}px`;
        parentRef.current.style.height = 'auto';
        parentRef.current.style.overflow = 'visible'; // Allow scrolling when min_height > page height
        parentRef.current.style.overflowX = 'hidden'; // Prevent horizontal scroll
      } else {
        parentRef.current.style.minHeight = '';
        parentRef.current.style.height = '';
        parentRef.current.style.overflow = '';
        parentRef.current.style.overflowX = '';
      }
    }
    
    // Also update grid container overflow
    if (gridRef.current) {
      if (hasMinHeight) {
        gridRef.current.style.overflow = 'visible';
        gridRef.current.style.overflowX = 'hidden';
      } else {
        gridRef.current.style.overflow = '';
        gridRef.current.style.overflowX = '';
      }
    }

    // Create container divs for each pane
    if (gridRef.current) {
      // Create panes (grid is already cleared on layout change above)
      const newContainerIds = new Map<string, string>();
      for (const pane of layout.layout.panes) {
        const containerId = `pane-${pane.id}`;
        newContainerIds.set(pane.id, containerId);
        
        // Check if this pane already exists in DOM
        const existingPane = document.getElementById(containerId);
        if (!existingPane) {
          // New pane - create container
          const paneDiv = document.createElement('div');
          paneDiv.id = containerId;
          paneDiv.className = 'relative w-full h-full';
          paneDiv.style.gridRow = `${pane.row + 1} / span ${pane.height}`;
          paneDiv.style.gridColumn = `${pane.col + 1} / span ${pane.width}`;
          paneDiv.style.position = 'relative';
          // Remove overflow-hidden when min_height is set to allow scrolling (use pre-calculated hasMinHeight)
          paneDiv.style.overflow = hasMinHeight ? 'visible' : 'hidden';
          
          // Add pane title if provided
          if (pane.title) {
            const titleDiv = document.createElement('div');
            titleDiv.className = 'pane-title absolute top-0 left-0 right-0 z-10 bg-card/80 backdrop-blur-sm px-2 py-1 text-xs font-medium text-foreground border-b border-border';
            titleDiv.textContent = pane.title;
            paneDiv.appendChild(titleDiv);
          }
          
          // Add chart container
          const chartContainer = document.createElement('div');
          chartContainer.id = `${containerId}-chart`;
          chartContainer.className = 'w-full h-full relative';
          if (pane.title) {
            chartContainer.style.paddingTop = '24px'; // Space for title
          }
          // When min_height is set, ensure chart container can grow
          if (hasMinHeight) {
            chartContainer.style.minHeight = '0'; // Allow flex/grid to control sizing
            chartContainer.style.height = '100%'; // Fill parent pane
          }
          paneDiv.appendChild(chartContainer);

          // Add "Waiting for Data" overlay container
          // Append to paneDiv (not chartContainer) so it appears above the chart canvas
          const waitingOverlay = document.createElement('div');
          waitingOverlay.id = `${containerId}-waiting`;
          // Position overlay to cover the chart area (accounting for title if present)
          const topOffset = pane.title ? '24px' : '0';
          waitingOverlay.className = 'absolute flex items-center justify-center bg-card/50 backdrop-blur-sm z-30 pointer-events-none';
          waitingOverlay.style.display = 'flex'; // CRITICAL: Show waiting by default - hidden when data arrives
          waitingOverlay.style.top = topOffset;
          waitingOverlay.style.left = '0';
          waitingOverlay.style.right = '0';
          waitingOverlay.style.bottom = '0';
          // The content will be updated dynamically based on pending series count
          waitingOverlay.innerHTML = `
            <div class="text-center">
              <div class="w-12 h-12 border-2 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-2"></div>
              <p class="text-sm text-muted-foreground">Waiting for Data...</p>
              <p class="text-xs text-muted-foreground mt-1" id="${containerId}-waiting-count"></p>
            </div>
          `;
          paneDiv.appendChild(waitingOverlay);
          
          gridRef.current.appendChild(paneDiv);
          
          // Notify parent that pane is ready (only once per pane)
          if (onPaneReady && !notifiedPanesRef.current.has(pane.id)) {
            notifiedPanesRef.current.add(pane.id);
            // Small delay to ensure DOM is ready
            setTimeout(() => {
              if (onPaneReady) { // Check again in case callback was removed
                onPaneReady(pane.id, `${containerId}-chart`);
              }
            }, 10);
          }
        } else {
          // Pane already exists in DOM - update overflow based on current layout's min_height
          const existingPaneDiv = document.getElementById(containerId);
          
          if (existingPaneDiv) {
            // Always update overflow based on current min_height setting (use pre-calculated hasMinHeight)
            existingPaneDiv.style.overflow = hasMinHeight ? 'visible' : 'hidden';
          }
          
          // Only notify if not already notified (shouldn't happen, but safety check)
          if (onPaneReady && !notifiedPanesRef.current.has(pane.id)) {
            notifiedPanesRef.current.add(pane.id);
            onPaneReady(pane.id, `${containerId}-chart`);
          }
        }
      }
      
      // Update overflow for ALL existing panes (in case layout changed but panes are reused)
      for (const [paneId, containerId] of containerIdsRef.current) {
        const existingPaneDiv = document.getElementById(containerId);
        if (existingPaneDiv) {
          // Update overflow based on current layout's min_height (use pre-calculated hasMinHeight)
          existingPaneDiv.style.overflow = hasMinHeight ? 'visible' : 'hidden';
        }
      }
      
      // Cleanup removed panes
      for (const [paneId, containerId] of containerIdsRef.current) {
        if (!newContainerIds.has(paneId)) {
          const container = document.getElementById(containerId);
          if (container) {
            container.remove();
          }
          notifiedPanesRef.current.delete(paneId); // Remove from notified set
          if (onPaneDestroyed) {
            onPaneDestroyed(paneId);
          }
        }
      }

      containerIdsRef.current = newContainerIds;

      // Now notify parent that grid is ready (after all panes are created)
      // Use a longer delay to ensure pane containers are fully in DOM
      if (onGridReady && !gridReadyNotifiedRef.current) {
        setTimeout(() => {
          const parentElement = document.getElementById('dynamic-plot-parent');
          if (parentElement && !gridReadyNotifiedRef.current) {
            console.log('[DynamicPlotGrid] All panes created, notifying parent that grid is ready');
            gridReadyNotifiedRef.current = true;
            onGridReady('dynamic-plot-parent', rows, cols);
          }
        }, 50); // Wait for pane containers to be ready
      }
    }
  }, [layout, onGridReady, onPaneReady, onPaneDestroyed, hasMinHeight, minHeight]);

  // Ensure parent container styles are always updated when layout/min_height changes
  // Use minHeight as direct dependency to ensure updates on layout changes
  useEffect(() => {
    if (parentRef.current && layout) {
      if (hasMinHeight && minHeight) {
        console.log('[DynamicPlotGrid] Setting min-height (layout effect):', minHeight);
        parentRef.current.style.minHeight = `${minHeight}px`;
        parentRef.current.style.height = 'auto';
        parentRef.current.style.overflow = 'visible'; // Allow scrolling when min_height > page height
        parentRef.current.style.overflowX = 'hidden'; // Prevent horizontal scroll
      } else {
        console.log('[DynamicPlotGrid] Clearing min-height (layout effect)');
        parentRef.current.style.minHeight = '';
        parentRef.current.style.height = '';
        parentRef.current.style.overflow = '';
        parentRef.current.style.overflowX = '';
      }
    }
    
    // Also update grid container overflow
    if (gridRef.current && layout) {
      if (hasMinHeight) {
        gridRef.current.style.overflow = 'visible';
        gridRef.current.style.overflowX = 'hidden';
      } else {
        gridRef.current.style.overflow = '';
        gridRef.current.style.overflowX = '';
      }
    }
    
    // Update all chart containers to ensure they respect min-height
    if (layout) {
      for (const [paneId, containerId] of containerIdsRef.current) {
        const chartContainer = document.getElementById(`${containerId}-chart`);
        if (chartContainer) {
          // Chart containers should fill their parent pane
          chartContainer.style.height = '100%';
          chartContainer.style.minHeight = '0'; // Allow flex/grid to control sizing
        }
      }
    }
  }, [layout, minHeight, hasMinHeight]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (gridRef.current) {
        gridRef.current.innerHTML = '';
      }
      containerIdsRef.current.clear();
    };
  }, []);

  // Determine container classes based on min_height (use the same hasMinHeight calculated above)
  // Remove h-full from className if min_height is set to allow growth
  const baseClassName = className.replace(/\bh-full\b/g, '').trim();
  const parentClassName = hasMinHeight 
    ? `w-full relative ${baseClassName}` 
    : `w-full h-full relative ${className}`;
  const gridClassName = hasMinHeight 
    ? "relative w-full" 
    : "absolute inset-0 w-full h-full";

  if (!layout) {
    return (
      <div className={`flex items-center justify-center h-full ${className}`}>
        <div className="text-center text-muted-foreground">
          <p className="text-sm">No layout loaded</p>
          <p className="text-xs mt-1">Load a plot layout JSON file to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={parentRef}
      id="dynamic-plot-parent"
      className={parentClassName}
    >
      <div
        ref={gridRef}
        className={gridClassName}
        style={gridStyle}
      />
    </div>
  );
}

