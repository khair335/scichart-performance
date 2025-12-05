// useLayoutManager - React hook for managing plot layouts
// Handles loading, validation, and state management of layout JSON files

import { useState, useCallback, useEffect } from 'react';
import type { PlotLayoutJSON, UIConfig } from '@/types/layout';
import { validateLayout } from '@/types/layout';
import { LayoutEngine } from '@/lib/layout-engine';

interface UseLayoutManagerOptions {
  uiConfig?: UIConfig;
  onLayoutChange?: (layout: PlotLayoutJSON | null) => void;
}

interface UseLayoutManagerReturn {
  currentLayout: PlotLayoutJSON | null;
  layoutHistory: PlotLayoutJSON[];
  isLoading: boolean;
  errors: string[];
  loadLayout: (layout: PlotLayoutJSON) => Promise<boolean>;
  loadLayoutFromFile: () => Promise<boolean>;
  loadLayoutFromUrl: (url: string) => Promise<boolean>;
  clearLayout: () => void;
  reloadLayout: () => Promise<boolean>;
}

export function useLayoutManager(options: UseLayoutManagerOptions = {}): UseLayoutManagerReturn {
  const { uiConfig, onLayoutChange } = options;
  
  const [currentLayout, setCurrentLayout] = useState<PlotLayoutJSON | null>(null);
  const [layoutHistory, setLayoutHistory] = useState<PlotLayoutJSON[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  
  // Load default layout from UI config on mount
  useEffect(() => {
    if (uiConfig?.layout?.defaultLayout) {
      loadLayoutFromUrl(uiConfig.layout.defaultLayout);
    }
  }, [uiConfig?.layout?.defaultLayout]);
  
  // Load a layout object directly
  const loadLayout = useCallback(async (layout: PlotLayoutJSON): Promise<boolean> => {
    setIsLoading(true);
    setErrors([]);
    
    try {
      // Validate
      const validation = validateLayout(layout);
      if (!validation.valid) {
        setErrors(validation.errors);
        setIsLoading(false);
        return false;
      }
      
      // Store current layout in history
      if (currentLayout) {
        setLayoutHistory(prev => [...prev, currentLayout]);
      }
      
      // Set new layout
      setCurrentLayout(layout);
      onLayoutChange?.(layout);
      
      console.log('[useLayoutManager] Layout loaded:', layout.meta?.name || 'unnamed');
      setIsLoading(false);
      return true;
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setErrors([error]);
      setIsLoading(false);
      return false;
    }
  }, [currentLayout, onLayoutChange]);
  
  // Load layout from file picker
  const loadLayoutFromFile = useCallback(async (): Promise<boolean> => {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json';
      
      input.onchange = async (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) {
          resolve(false);
          return;
        }
        
        try {
          const text = await file.text();
          const layout = JSON.parse(text) as PlotLayoutJSON;
          const success = await loadLayout(layout);
          resolve(success);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          setErrors([`Failed to parse layout file: ${error}`]);
          resolve(false);
        }
      };
      
      input.oncancel = () => resolve(false);
      input.click();
    });
  }, [loadLayout]);
  
  // Load layout from URL
  const loadLayoutFromUrl = useCallback(async (url: string): Promise<boolean> => {
    setIsLoading(true);
    setErrors([]);
    
    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch layout: ${response.status}`);
      }
      
      const layout = await response.json() as PlotLayoutJSON;
      return await loadLayout(layout);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      setErrors([error]);
      setIsLoading(false);
      return false;
    }
  }, [loadLayout]);
  
  // Clear current layout
  const clearLayout = useCallback(() => {
    if (currentLayout) {
      setLayoutHistory(prev => [...prev, currentLayout]);
    }
    setCurrentLayout(null);
    setErrors([]);
    onLayoutChange?.(null);
    console.log('[useLayoutManager] Layout cleared');
  }, [currentLayout, onLayoutChange]);
  
  // Reload current layout
  const reloadLayout = useCallback(async (): Promise<boolean> => {
    if (!currentLayout) return false;
    return loadLayout(currentLayout);
  }, [currentLayout, loadLayout]);
  
  return {
    currentLayout,
    layoutHistory,
    isLoading,
    errors,
    loadLayout,
    loadLayoutFromFile,
    loadLayoutFromUrl,
    clearLayout,
    reloadLayout,
  };
}
