/**
 * DynamicPlotGrid Component
 * Renders a dynamic MxN grid of chart panes based on plot layout
 */

import { useEffect, useRef, useState } from 'react';
import type { ParsedLayout, PaneConfig } from '@/types/plot-layout';

interface DynamicPlotGridProps {
  layout: ParsedLayout | null;
  onPaneReady?: (paneId: string, containerId: string) => void;
  onPaneDestroyed?: (paneId: string) => void;
  onGridReady?: (parentContainerId: string, rows: number, cols: number) => void;
  className?: string;
}

export function DynamicPlotGrid({
  layout,
  onPaneReady,
  onPaneDestroyed,
  onGridReady,
  className = ''
}: DynamicPlotGridProps) {
  const parentRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const containerIdsRef = useRef<Map<string, string>>(new Map());
  const notifiedPanesRef = useRef<Set<string>>(new Set());
  const gridReadyNotifiedRef = useRef<boolean>(false);
  const [gridStyle, setGridStyle] = useState<React.CSSProperties>({});

  // Separate effect to notify when grid container is ready in DOM
  useEffect(() => {
    if (!layout || !onGridReady || gridReadyNotifiedRef.current) {
      return;
    }

    const [rows, cols] = layout.layout.grid;

    // Wait for next tick to ensure parentRef is set
    const timeoutId = setTimeout(() => {
      if (parentRef.current) {
        console.log('[DynamicPlotGrid] Parent container ready, notifying parent');
        gridReadyNotifiedRef.current = true;
        onGridReady('dynamic-plot-parent', rows, cols);
      } else {
        console.warn('[DynamicPlotGrid] Parent ref not set yet');
      }
    }, 0);

    return () => clearTimeout(timeoutId);
  }, [layout, onGridReady]);

  useEffect(() => {
    if (!layout) {
      // No layout - clear grid
      if (gridRef.current) {
        gridRef.current.innerHTML = '';
      }
      containerIdsRef.current.clear();
      gridReadyNotifiedRef.current = false;
      return;
    }

    const [rows, cols] = layout.layout.grid;

    // Set CSS Grid layout
    setGridStyle({
      display: 'grid',
      gridTemplateRows: `repeat(${rows}, 1fr)`,
      gridTemplateColumns: `repeat(${cols}, 1fr)`,
      width: '100%',
      height: '100%',
      gap: '1px',
    });

    // Create container divs for each pane
    if (gridRef.current) {
      // Don't clear innerHTML - preserve existing panes and only update what's needed
      const oldContainerIds = new Set(containerIdsRef.current.values());
      
      // Create panes
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
          paneDiv.style.overflow = 'hidden';
          
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
          paneDiv.appendChild(chartContainer);

          // Add "Waiting for Data" overlay container
          // Append to paneDiv (not chartContainer) so it appears above the chart canvas
          const waitingOverlay = document.createElement('div');
          waitingOverlay.id = `${containerId}-waiting`;
          // Position overlay to cover the chart area (accounting for title if present)
          const topOffset = pane.title ? '24px' : '0';
          waitingOverlay.className = 'absolute flex items-center justify-center bg-card/50 backdrop-blur-sm z-30 pointer-events-none';
          waitingOverlay.style.display = 'none'; // Hidden by default, shown when waiting
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
          // Pane already exists in DOM - check if we need to update it
          // (e.g., if grid position changed, but for now we'll just skip)
          // Only notify if not already notified (shouldn't happen, but safety check)
          if (onPaneReady && !notifiedPanesRef.current.has(pane.id)) {
            notifiedPanesRef.current.add(pane.id);
            onPaneReady(pane.id, `${containerId}-chart`);
          }
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
    }
  }, [layout]); // Removed onPaneReady and onPaneDestroyed from deps to prevent re-runs

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (gridRef.current) {
        gridRef.current.innerHTML = '';
      }
      containerIdsRef.current.clear();
    };
  }, []);

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
      className={`w-full h-full relative ${className}`}
    >
      <div
        ref={gridRef}
        className="absolute inset-0 w-full h-full"
        style={gridStyle}
      />
    </div>
  );
}

