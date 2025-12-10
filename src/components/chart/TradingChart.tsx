import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useMultiPaneChart } from './MultiPaneChart';
import { useWebSocketFeed } from '@/hooks/useWebSocketFeed';
import { useDemoDataGenerator } from '@/hooks/useDemoDataGenerator';
import { HUD } from './HUD';
import { Toolbar } from './Toolbar';
import { SeriesBrowser } from './SeriesBrowser';
import { CommandPalette } from './CommandPalette';
import { defaultChartConfig } from '@/types/chart';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play, X, Grid3x3, FileJson } from 'lucide-react';
import type { Sample, RegistryRow } from '@/lib/wsfeed-client';
import { parseSeriesType } from '@/lib/series-namespace';
import { parsePlotLayout, getDefaultLayout, type ParsedLayout } from '@/types/plot-layout';
import { DynamicPlotGrid } from './DynamicPlotGrid';

interface NoConnectionOverlayProps {
  wsUrl: string;
  onStartDemo: () => void;
  autoReloadEnabled: boolean;
  onCancelAutoReload: () => void;
}

interface NoLayoutOverlayProps {
  onLoadLayout: () => void;
}

const NoLayoutOverlay = ({ onLoadLayout }: NoLayoutOverlayProps) => {
  return (
    <div className="absolute inset-0 flex items-center justify-center z-30">
      <div className="absolute inset-0 bg-gradient-to-br from-background/95 via-background/90 to-background/95 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
      <div className="relative text-center max-w-md px-8 py-10 glass-card fade-in">
        {/* Grid Icon */}
        <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-primary/20 to-accent/20 flex items-center justify-center mx-auto mb-6 border border-primary/30 shadow-lg">
          <Grid3x3 className="w-12 h-12 text-primary" />
        </div>
        
        {/* Title */}
        <h3 className="text-3xl font-bold text-foreground mb-3 gradient-text">No Layout Loaded</h3>
        
        {/* Description */}
        <p className="text-sm text-muted-foreground mb-2 leading-relaxed">
          Load a plot layout JSON file to visualize data. Data is being collected in the background.
        </p>
        <p className="text-sm text-muted-foreground mb-8 leading-relaxed">
          Use the toolbar to load a layout file.
        </p>
        
        {/* Load Layout Button */}
        <Button 
          onClick={onLoadLayout}
          className="bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground font-semibold px-6 py-2.5 rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 btn-modern"
        >
          <FileJson className="w-4 h-4 mr-2" />
          Load Layout File
        </Button>
      </div>
    </div>
  );
};

const NoConnectionOverlay = ({ wsUrl, onStartDemo, autoReloadEnabled, onCancelAutoReload }: NoConnectionOverlayProps) => {
  const [countdown, setCountdown] = useState(3);
  const countdownRef = useRef<NodeJS.Timeout | null>(null);
  const reloadTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    if (!autoReloadEnabled) {
      // Clear any pending reloads if auto-reload is disabled
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
        reloadTimeoutRef.current = null;
      }
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      return;
    }

    // Reset countdown
    setCountdown(3);

    // Start countdown
    countdownRef.current = setInterval(() => {
      setCountdown(prev => {
        if (prev <= 1) {
          if (countdownRef.current) {
            clearInterval(countdownRef.current);
            countdownRef.current = null;
          }
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    // Schedule reload after 3 seconds
    reloadTimeoutRef.current = setTimeout(() => {
      window.location.reload();
    }, 3000);

    // Cleanup
    return () => {
      if (countdownRef.current) {
        clearInterval(countdownRef.current);
        countdownRef.current = null;
      }
      if (reloadTimeoutRef.current) {
        clearTimeout(reloadTimeoutRef.current);
        reloadTimeoutRef.current = null;
      }
    };
  }, [autoReloadEnabled]);

  return (
    <div className="absolute inset-0 flex items-center justify-center z-30">
      <div className="absolute inset-0 bg-gradient-to-br from-background/98 via-background/99 to-background/100 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
      <div className="relative text-center max-w-md px-8 py-10 glass-card fade-in">
        {/* Cancel button */}
        {autoReloadEnabled && (
          <button
            onClick={onCancelAutoReload}
            className="absolute top-4 right-4 p-2 rounded-lg hover:bg-destructive/20 transition-colors border border-transparent hover:border-destructive/30"
            aria-label="Cancel auto-reload"
          >
            <X className="w-5 h-5 text-muted-foreground hover:text-destructive" />
          </button>
        )}

        <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-destructive/30 to-destructive/10 flex items-center justify-center mx-auto mb-6 border border-destructive/40 shadow-lg">
          <span className="text-destructive text-4xl font-bold">!</span>
        </div>
        <h3 className="text-2xl font-bold text-foreground mb-3">No Data Connection</h3>
        <p className="text-sm text-muted-foreground mb-4 leading-relaxed">
          WebSocket server not available. Start the server or use demo mode.
        </p>
        <code className="text-xs text-muted-foreground font-mono bg-muted/50 border border-border/50 px-4 py-2 rounded-lg block mb-4 backdrop-blur-sm">
          {wsUrl}
        </code>
        
        {autoReloadEnabled && countdown > 0 && (
          <div className="mb-6 px-4 py-2 rounded-lg bg-warning/10 border border-warning/30">
            <p className="text-sm text-warning font-semibold">
              Reloading in <span className="text-2xl font-bold">{countdown}</span> second{countdown !== 1 ? 's' : ''}...
            </p>
          </div>
        )}
        
        <div className="flex flex-col gap-3">
          <Button 
            onClick={onStartDemo}
            className="w-full bg-gradient-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground font-semibold px-6 py-2.5 rounded-lg shadow-lg hover:shadow-xl transition-all duration-300 btn-modern"
          >
            <Play className="w-4 h-4 mr-2" />
            Start Demo Mode
          </Button>
          <p className="text-xs text-muted-foreground">
            Or run: <code className="bg-muted/50 border border-border/50 px-2 py-1 rounded font-mono">python server.py</code>
          </p>
        </div>
      </div>
    </div>
  );
};

interface TradingChartProps {
  wsUrl?: string;
  className?: string;
  uiConfig?: any;
}

export function TradingChart({ wsUrl = 'ws://127.0.0.1:8765', className, uiConfig }: TradingChartProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [minimapEnabled, setMinimapEnabled] = useState(defaultChartConfig.minimap.enabled);
  const [seriesBrowserOpen, setSeriesBrowserOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set());
  const [isLive, setIsLive] = useState(true);
  const [fps, setFps] = useState(0);
  const [dataClockMs, setDataClockMs] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const [demoRegistry, setDemoRegistry] = useState<RegistryRow[]>([]);
  const [autoReloadEnabled, setAutoReloadEnabled] = useState(true);
  const [hudVisible, setHudVisible] = useState(true);
  const [zoomMode, setZoomMode] = useState<'box' | 'x-only' | 'y-only'>('box');
  const [isFullscreen, setIsFullscreen] = useState(false);
  
  // Plot layout state
  const [plotLayout, setPlotLayout] = useState<ParsedLayout | null>(null);
  const [currentLayoutName, setCurrentLayoutName] = useState<string | null>(null); // Track loaded layout name/filename
  const [layoutError, setLayoutError] = useState<string | null>(null); // Track validation errors for UI display
  
  // Performance metrics for HUD
  const [cpuUsage, setCpuUsage] = useState(0);
  const [memoryUsage, setMemoryUsage] = useState(0);
  const [gpuMetrics, setGpuMetrics] = useState({ drawCalls: 0, triangles: 0 });

  // Handle samples from any source - defined early so it can be used in useWebSocketFeed
  const handleSamplesRef = useRef<(samples: Sample[]) => void>(() => {});
  
  // WebSocket feed - must be called before useMultiPaneChart to get feedState
  const { state: feedState, registry: wsRegistry } = useWebSocketFeed({
    url: wsUrl,
    onSamples: (samples) => handleSamplesRef.current(samples),
    autoConnect: !demoMode,
  });

  // Use appropriate registry based on mode - must be defined before useMultiPaneChart
  const registry = demoMode ? demoRegistry : wsRegistry;

  // Load UI config and default layout on mount
  useEffect(() => {
    let mounted = true;

    async function loadDefaultLayout() {
      if (plotLayout) {
        // Layout already loaded, skip
        return;
      }

      try {
        // Fetch ui-config.json
        const configResponse = await fetch('/ui-config.json');
        if (!configResponse.ok) {
          console.warn('[TradingChart] Failed to load ui-config.json');
          return;
        }

        const config = await configResponse.json();

        // Check for defaultLayoutPath
        if (config.defaultLayoutPath && mounted) {
          try {
            console.log('[TradingChart] Loading default layout from:', config.defaultLayoutPath);
            const layoutResponse = await fetch(config.defaultLayoutPath);

            if (!layoutResponse.ok) {
              throw new Error(`Failed to fetch layout: ${layoutResponse.statusText}`);
            }

            const layoutJson = await layoutResponse.json();
            const validationErrors: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] };

            const parsed = parsePlotLayout(layoutJson, (errs) => {
              validationErrors.errors.push(...errs.errors);
              validationErrors.warnings.push(...errs.warnings);
            });

            // Extract filename from path (e.g., "/layouts/layout-3x1-simple.json" -> "layout-3x1-simple")
            const layoutPath = config.defaultLayoutPath;
            const filename = layoutPath.split('/').pop()?.replace('.json', '') || 'Default Layout';

            if (mounted) {
              setPlotLayout(parsed);
              setCurrentLayoutName(filename);
              setLayoutError(null);

              if (validationErrors.warnings.length > 0) {
                console.warn('[TradingChart] Default layout validation warnings:', validationErrors.warnings);
              }
              console.log('[TradingChart] Loaded default layout:', parsed.layout.grid);
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn('[TradingChart] Failed to load default layout file:', error);

            if (mounted) {
              setLayoutError(errorMsg);
            }
          }
        } else if (config.defaultLayout && mounted) {
          // Fallback: load embedded defaultLayout from config
          try {
            const validationErrors: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] };
            const parsed = parsePlotLayout(config.defaultLayout, (errs) => {
              validationErrors.errors.push(...errs.errors);
              validationErrors.warnings.push(...errs.warnings);
            });

            if (mounted) {
              setPlotLayout(parsed);
              // For embedded layout, use a default name
              setCurrentLayoutName('Default Layout');
              setLayoutError(null);

              if (validationErrors.warnings.length > 0) {
                console.warn('[TradingChart] Default layout validation warnings:', validationErrors.warnings);
              }
              console.log('[TradingChart] Loaded embedded default layout:', parsed.layout.grid);
            }
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            console.warn('[TradingChart] Failed to parse embedded default layout:', error);

            if (mounted) {
              setLayoutError(errorMsg);
            }
          }
        }
      } catch (error) {
        console.warn('[TradingChart] Failed to load ui-config.json:', error);
      }
    }

    loadDefaultLayout();

    return () => {
      mounted = false;
    };
  }, [plotLayout]);

  // Initialize multi-pane charts
  const {
    isReady,
    appendSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
    handleGridReady,
  } = useMultiPaneChart({
    tickContainerId: 'tick-chart',
    ohlcContainerId: 'ohlc-chart',
    overviewContainerId: 'overview-chart', // Always pass the ID, visibility controlled by CSS
    onFpsUpdate: setFps,
    onDataClockUpdate: setDataClockMs,
    onReadyChange: () => {},
    onGpuUpdate: (drawCalls) => setGpuMetrics({ drawCalls, triangles: 0 }),
    visibleSeries,
    feedStage: demoMode ? 'demo' : feedState.stage,
    uiConfig: uiConfig,
    registry: registry, // Pass registry for global data clock calculation
    plotLayout: plotLayout, // Pass parsed layout
    zoomMode: zoomMode, // Pass zoom mode
  });

  // Update tick count from registry (total count, not just new samples)
  useEffect(() => {
    if (!registry || registry.length === 0) return;

    // Sum up all tick series counts from registry
    const totalTicks = registry
      .filter(r => r.id.includes(':ticks'))
      .reduce((sum, r) => sum + r.count, 0);

    setTickCount(totalTicks);
  }, [registry]);

  // Handle samples from any source
  const handleSamples = useCallback((samples: Sample[]) => {
    appendSamples(samples);

    // Update demo registry
    if (demoMode) {
      setDemoRegistry(prev => {
        const map = new Map(prev.map(r => [r.id, r]));
        for (const s of samples) {
          const existing = map.get(s.series_id);
          if (existing) {
            existing.count++;
            existing.lastSeq = s.seq;
            existing.lastMs = s.t_ms;
          } else {
            map.set(s.series_id, {
              id: s.series_id,
              count: 1,
              firstSeq: s.seq,
              lastSeq: s.seq,
              firstMs: s.t_ms,
              lastMs: s.t_ms,
              firstSeriesSeq: null,
              lastSeriesSeq: null,
              gaps: 0,
              missed: 0,
            });
          }
        }
        return Array.from(map.values());
      });
    }
  }, [appendSamples, demoMode]);

  // Update the ref so useWebSocketFeed can call it
  useEffect(() => {
    handleSamplesRef.current = handleSamples;
  }, [handleSamples]);

  // Performance monitoring
  useEffect(() => {
    const updatePerformanceMetrics = () => {
      // Memory usage (if available) - Chrome/Edge only
      const perf = performance as any;
      if (perf.memory) {
        const memMB = perf.memory.usedJSHeapSize / (1024 * 1024);
        setMemoryUsage(memMB);
      }
      
      // CPU usage estimation (rough approximation using performance.now())
      // Track idle time vs active time
      const idleCallback = (deadline: IdleDeadline) => {
        const idleTime = deadline.timeRemaining();
        const cpuPercent = Math.max(0, Math.min(100, 100 - (idleTime / 16.67) * 100));
        setCpuUsage(cpuPercent);
      };
      
      if ('requestIdleCallback' in window) {
        requestIdleCallback(idleCallback);
      }
    };
    
    const interval = setInterval(updatePerformanceMetrics, 1000);
    return () => clearInterval(interval);
  }, []);

  // Demo data generator
  useDemoDataGenerator({
    enabled: demoMode,
    ticksPerSecond: 50,
    basePrice: 6000,
    onSamples: handleSamples,
  });

  // Registry is now defined earlier (before useMultiPaneChart) to avoid initialization error

  // Track which series have been manually toggled by user
  const manuallyToggledRef = useRef<Set<string>>(new Set());
  // Track explicitly hidden series (user turned them off)
  const explicitlyHiddenRef = useRef<Set<string>>(new Set());
  // Track if initial load has happened (to distinguish from "Clear All")
  const hasInitializedRef = useRef(false);
  // Track if user explicitly cleared all (to prevent auto-adding back)
  const userClearedAllRef = useRef(false);
  // Track recently toggled series to prevent useEffect interference (debounce)
  const recentlyToggledRef = useRef<Set<string>>(new Set());
  
  // Define handlers before useEffect that uses them
  const handleToggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.classList.toggle('light', next === 'light');
      return next;
    });
  }, []);

  const handleJumpToLive = useCallback(() => {
    setIsLive(true);
    setLiveMode(true);
    jumpToLive();
  }, [setLiveMode, jumpToLive]);

  const handleToggleFullscreen = useCallback(() => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().then(() => {
        setIsFullscreen(true);
      }).catch(err => {
        console.error('Error entering fullscreen:', err);
      });
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
      }).catch(err => {
        console.error('Error exiting fullscreen:', err);
      });
    }
  }, []);

  // Listen for fullscreen changes
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
    };
  }, []);

  // Keyboard shortcuts (hotkeys)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if typing in input/textarea
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') {
        return;
      }
      
      // Ctrl/Cmd+K: Command Palette
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      
      // Single key shortcuts (only when not in input)
      switch (e.key.toLowerCase()) {
        case 'j':
          // J: Jump to live
          e.preventDefault();
          handleJumpToLive();
          break;
        case 'm':
          // M: Toggle minimap
          e.preventDefault();
          setMinimapEnabled(prev => !prev);
          break;
        case 'h':
          // H: Toggle HUD
          e.preventDefault();
          setHudVisible(prev => !prev);
          break;
        case 't':
          // T: Toggle theme
          e.preventDefault();
          handleToggleTheme();
          break;
        case 'f':
          // F: Fullscreen
          e.preventDefault();
          handleToggleFullscreen();
          break;
        case 'b':
          // B: Box zoom mode
          e.preventDefault();
          setZoomMode('box');
          break;
        case 'x':
          // X: X-only zoom mode
          e.preventDefault();
          setZoomMode('x-only');
          break;
        case 'y':
          // Y: Y-only zoom mode
          e.preventDefault();
          setZoomMode('y-only');
          break;
        case 'z':
          // Z: Zoom extents
          e.preventDefault();
          zoomExtents();
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleJumpToLive, handleToggleTheme, zoomExtents, zoomMode]);
  
  // Keep visibleSeries in sync with discovered series.
  // - On first load: turn ALL series ON by default.
  // - When new series appear later: add them as visible, but never re-toggle ones the user has changed.
  // - Respect "Clear All" action - don't auto-add series back if user cleared them
  useEffect(() => {
    if (registry.length === 0) return;

    setVisibleSeries(prev => {
      // Initial load: show price and indicators, but hide strategy series by default
      // Strategy series (PnL, signals, markers) have different Y-axis scales and can make price data appear tiny
      // CRITICAL: Initialize even if hasInitializedRef is true IF prev.size is 0 and registry has data
      // This handles the case where registry wasn't populated during first initialization
      if (prev.size === 0 && (!hasInitializedRef.current || registry.length > 0)) {
        hasInitializedRef.current = true;
        // Filter out strategy series - they should be hidden by default
        const visible = new Set(
          registry
            .filter(row => {
              const seriesInfo = parseSeriesType(row.id);
              // Hide strategy series by default (they have different Y-axis scales)
              return seriesInfo.type !== 'strategy-pnl' &&
                     seriesInfo.type !== 'strategy-signal' &&
                     seriesInfo.type !== 'strategy-marker';
            })
            .map(r => r.id)
        );
        console.log(`[TradingChart] 🔄 Initializing visibleSeries with ${visible.size} series from registry of ${registry.length}`);
        return visible;
      }
      
      // If user explicitly cleared all and nothing is visible, don't auto-add series back
      if (userClearedAllRef.current && prev.size === 0) {
        return prev; // Keep it empty
      }
      
      // Subsequent updates: add any new series IDs, keep user choices intact
      // IMPORTANT: Never auto-add series that user has explicitly hidden or recently toggled
      // Even if userClearedAllRef is true, we still respect explicitlyHiddenRef for individual series
      const next = new Set(prev);
      for (const row of registry) {
        if (!next.has(row.id)) {
          // Only auto-add if:
          // 1. User hasn't explicitly hidden this specific series (checked first - most important)
          // 2. User hasn't recently toggled this series (prevent race condition)
          // 3. If user cleared all, only add if it's NOT in the explicitly hidden list
          //    (meaning user manually toggled it back on, which removes it from hidden list)
          if (!explicitlyHiddenRef.current.has(row.id) && 
              !recentlyToggledRef.current.has(row.id)) {
            // If user cleared all, don't auto-add - user must manually toggle each one
            // If user didn't clear all, auto-add any missing series
            if (!userClearedAllRef.current) {
              next.add(row.id);
            }
            // If userClearedAllRef is true, don't auto-add - user must manually toggle each one
          }
        }
      }
      return next;
    });
  }, [registry]);

  const handleSelectAllSeries = useCallback(() => {
    const allSeriesIds = registry.map(row => row.id);
    setVisibleSeries(new Set(allSeriesIds));
    // Mark all as manually toggled
    allSeriesIds.forEach(id => manuallyToggledRef.current.add(id));
    // Reset the "cleared all" flag since user is selecting all
    userClearedAllRef.current = false;
  }, [registry]);

  const handleSelectNoneSeries = useCallback(() => {
    setVisibleSeries(new Set());
    // Clear manually toggled tracking when clearing all
    manuallyToggledRef.current.clear();
    // Mark ALL series in registry as explicitly hidden (prevents auto-adding back)
    explicitlyHiddenRef.current = new Set(registry.map(r => r.id));
    // Mark that user explicitly cleared all (prevents auto-adding back)
    userClearedAllRef.current = true;
  }, [registry]);

  const handleToggleLive = useCallback(() => {
    const newLive = !isLive;
    setIsLive(newLive);
    setLiveMode(newLive);
  }, [isLive, setLiveMode]);

  // Handle moving series between panes
  const handleMoveSeries = useCallback((seriesId: string, targetPaneId: string) => {
    if (!plotLayout) {
      console.warn('[TradingChart] Cannot move series: no layout loaded');
      return;
    }
    
    // Find the series assignment in the layout
    const seriesAssignment = plotLayout.layout.series.find(s => s.series_id === seriesId);
    if (!seriesAssignment) {
      console.warn(`[TradingChart] Series ${seriesId} not found in layout`);
      return;
    }
    
    // Check if target pane exists
    const targetPane = plotLayout.layout.panes.find(p => p.id === targetPaneId);
    if (!targetPane) {
      console.warn(`[TradingChart] Target pane ${targetPaneId} not found in layout`);
      return;
    }
    
    // Update the series assignment
    seriesAssignment.pane = targetPaneId;
    
    // Re-parse the layout to update internal maps
    const updatedLayout = parsePlotLayout(plotLayout.layout);
    
    // Update the layout state - this will trigger MultiPaneChart to move the series
    setPlotLayout(updatedLayout);
    
   
  }, [plotLayout]);

  const handleToggleSeries = useCallback((seriesId: string) => {
    // Mark this series as manually toggled
    manuallyToggledRef.current.add(seriesId);
    // Mark as recently toggled to prevent useEffect interference
    recentlyToggledRef.current.add(seriesId);
    // Clear the "recently toggled" flag after a short delay
    setTimeout(() => {
      recentlyToggledRef.current.delete(seriesId);
    }, 100);
    
    setVisibleSeries(prev => {
      const next = new Set(prev);
      if (next.has(seriesId)) {
        // User is turning it OFF
        next.delete(seriesId);
        explicitlyHiddenRef.current.add(seriesId);
      } else {
        // User is turning it ON
        next.add(seriesId);
        // Remove from explicitly hidden list (user wants it visible)
        explicitlyHiddenRef.current.delete(seriesId);
        // DON'T reset userClearedAllRef here - keep it true so other series stay hidden
        // Only reset it when user explicitly selects all
      }
      return next;
    });
  }, []);

  const handleLoadLayout = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        try {
          const text = await file.text();
          const layoutJson = JSON.parse(text);
  
          
          // Enhanced validation with error collection
          const validationErrors: { errors: string[]; warnings: string[] } = { errors: [], warnings: [] };
          
          // Parse and validate the layout
          const parsed = parsePlotLayout(layoutJson, (errs) => {
            validationErrors.errors.push(...errs.errors);
            validationErrors.warnings.push(...errs.warnings);
          });
          
          // Set layout name from filename
          const layoutName = file.name.replace('.json', '') || 'Custom Layout';
          setCurrentLayoutName(layoutName);
          
          // Display warnings if any (non-blocking)
          if (validationErrors.warnings.length > 0) {
            console.warn('[TradingChart] Layout validation warnings:', validationErrors.warnings);
            // Could show a toast notification here
          }
          
          setPlotLayout(parsed);
          setLayoutError(null); // Clear any previous errors
          
          // Update visible series based on layout
          // CRITICAL: Add all series from layout to visibleSeries, even if not in registry yet
          // They will be created when data arrives and should be visible by default
          const seriesToActivate = new Set<string>();
          
          // First, add all series explicitly defined in the layout
          for (const seriesAssignment of parsed.layout.series) {
            seriesToActivate.add(seriesAssignment.series_id);
          }
          
          // Also add any matching series from registry (in case IDs differ slightly)
          for (const seriesAssignment of parsed.layout.series) {
            const matchingSeries = registry.find(r => 
              r.id === seriesAssignment.series_id || 
              r.id.includes(seriesAssignment.series_id) ||
              seriesAssignment.series_id.includes(r.id)
            );
            if (matchingSeries && matchingSeries.id !== seriesAssignment.series_id) {
              seriesToActivate.add(matchingSeries.id);
            }
          }
          
          if (seriesToActivate.size > 0) {
            setVisibleSeries(seriesToActivate);
          
          } else {
            console.warn('[TradingChart] No series found in layout to activate');
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error('[TradingChart] Failed to load layout:', err);
          setLayoutError(errorMsg);
          setCurrentLayoutName(null);
          // Display error in UI (alert for now, could be replaced with toast)
          alert('Failed to load layout:\n\n' + errorMsg);
        }
      }
    };
    input.click();
  }, [registry]);

  const handleReloadLayout = useCallback(() => {
    // Reload the current layout by re-triggering the load
    if (currentLayoutName) {
      handleLoadLayout();
    }
  }, [currentLayoutName, handleLoadLayout]);

  const handleStartDemo = useCallback(() => {
    setDemoMode(true);
    setTickCount(0);
    setDemoRegistry([]);
  }, []);

  const isConnected = demoMode || feedState.stage === 'live' || feedState.stage === 'history' || feedState.stage === 'delta';
  const currentStage = demoMode ? 'demo' : feedState.stage;
  
  // Check if min_height is set in layout (if > 0, remove overflow-hidden to allow scrolling)
  const hasMinHeight = plotLayout?.layout.min_height !== undefined && (plotLayout.layout.min_height ?? 0) > 0;

  // Ensure the page can scroll when a layout requests a minimum height
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;

    if (hasMinHeight) {
      html.style.overflowY = 'auto';
      body.style.overflowY = 'auto';
    } else {
      html.style.overflowY = '';
      body.style.overflowY = '';
    }

    return () => {
      html.style.overflowY = '';
      body.style.overflowY = '';
    };
  }, [hasMinHeight]);

  return (
    <div className={cn('flex flex-col h-screen relative', hasMinHeight ? 'overflow-y-auto overflow-x-hidden' : 'overflow-hidden', className)}>
      {/* Top Toolbar */}
      <Toolbar
        isLive={isLive}
        minimapEnabled={minimapEnabled}
        theme={theme}
        onJumpToLive={handleJumpToLive}
        onToggleLive={handleToggleLive}
        onZoomExtents={zoomExtents}
        onToggleFullscreen={handleToggleFullscreen}
        onToggleMinimap={() => setMinimapEnabled(!minimapEnabled)}
        onToggleTheme={handleToggleTheme}
        onLoadLayout={handleLoadLayout}
        onOpenSeriesBrowser={() => setSeriesBrowserOpen(true)}
        currentLayoutName={currentLayoutName}
        layoutError={layoutError}
        onReloadLayout={handleReloadLayout}
        seriesCount={registry.length}
        onOpenCommandPalette={() => setCommandPaletteOpen(true)}
        isFullscreen={isFullscreen}
        className="shrink-0 border-b border-border"
      />

      {/* HUD Status Bar */}
      {hudVisible && (
        <HUD
          stage={currentStage}
          rate={demoMode ? 50 : feedState.rate}
          fps={fps}
          heartbeatLag={demoMode ? 0 : feedState.heartbeatLag}
          dataClockMs={dataClockMs}
          isLive={isLive}
          historyProgress={demoMode ? 100 : feedState.historyProgress}
          tickCount={tickCount}
          cpuUsage={cpuUsage}
          memoryUsage={memoryUsage}
          gpuDrawCalls={gpuMetrics.drawCalls}
          currentLayoutName={currentLayoutName}
          onReloadLayout={handleReloadLayout}
          seriesCount={registry.length}
          minimapEnabled={minimapEnabled}
          onToggleMinimap={() => setMinimapEnabled(!minimapEnabled)}
          theme={theme}
          onToggleTheme={handleToggleTheme}
          onOpenCommandPalette={() => setCommandPaletteOpen(true)}
          onToggleFullscreen={handleToggleFullscreen}
          isFullscreen={isFullscreen}
          className="shrink-0 border-b border-border"
        />
      )}

      {/* Main Chart Area */}
      <div className={cn('flex-1 flex flex-col relative z-10', hasMinHeight ? 'min-h-0 overflow-visible' : 'min-h-0 overflow-hidden')}>
        {/* Dynamic Plot Grid - renders based on layout */}
        {/* CRITICAL: UI must not plot any data unless a plot layout JSON is loaded */}
        {/* Requirement 0.1: Layout-Driven Rendering - no plotting without layout */}
        <DynamicPlotGrid
          layout={plotLayout}
          onGridReady={handleGridReady}
          onPaneReady={(paneId, containerId) => {
            // Pane container is ready - MultiPaneChart will create surface

          }}
          onPaneDestroyed={(paneId) => {
            // Pane was removed - MultiPaneChart will cleanup

          }}
          className="w-full h-full"
        />

        {/* Connection Status Overlay */}
        {!isConnected && feedState.stage !== 'connecting' && (
          <NoConnectionOverlay
            wsUrl={wsUrl}
            onStartDemo={handleStartDemo}
            autoReloadEnabled={autoReloadEnabled}
            onCancelAutoReload={() => setAutoReloadEnabled(false)}
          />
        )}

        {/* Connecting Overlay */}
        {feedState.stage === 'connecting' && !demoMode && (
          <div className="absolute inset-0 flex items-center justify-center z-30">
            <div className="absolute inset-0 bg-gradient-to-br from-background/98 via-background/99 to-background/100 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
            <div className="relative text-center glass-card px-8 py-10 fade-in">
              <div className="w-20 h-20 border-4 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-6 shadow-lg" />
              <h3 className="text-2xl font-bold text-foreground mb-2 gradient-text">Connecting...</h3>
              <p className="text-sm text-muted-foreground">
                Establishing connection to data feed
              </p>
            </div>
          </div>
        )}

        {/* No Layout Overlay - Show when connected but no layout loaded (highest priority after connection) */}
        {isConnected && !plotLayout && (
          <NoLayoutOverlay onLoadLayout={handleLoadLayout} />
        )}

        {/* Chart Loading Overlay - Only show if layout is loaded but chart not ready */}
        {isConnected && plotLayout && !isReady && (
          <div className="absolute inset-0 flex items-center justify-center z-20">
            <div className="absolute inset-0 bg-gradient-to-br from-background/98 via-background/99 to-background/100 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
            <div className="relative text-center glass-card px-8 py-10 fade-in">
              <div className="w-20 h-20 border-4 border-primary/30 border-t-primary rounded-full animate-spin mx-auto mb-6 shadow-lg" />
              <h3 className="text-2xl font-bold text-foreground mb-2 gradient-text">Initializing Chart</h3>
              <p className="text-sm text-muted-foreground">
                Loading SciChart WebAssembly engine...
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Overview/Minimap (always rendered, visibility controlled by CSS) */}
      <div 
        className={`shrink-0 border-t border-border/60 relative glass-card transition-all duration-200 ${
          minimapEnabled 
            ? 'h-20 opacity-100 overflow-visible' 
            : 'h-0 opacity-0 overflow-hidden pointer-events-none'
        }`}
      >
        <div id="overview-chart" className="w-full h-full rounded-b-lg" />
        {/* "Waiting for Data" overlay for minimap */}
        <div id="overview-chart-waiting" className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-md z-20 pointer-events-none rounded-b-lg" style={{ display: 'none' }}>
          <div className="text-center">
            <div className="w-8 h-8 border-2 border-primary/50 border-t-primary rounded-full animate-spin mx-auto mb-1"></div>
            <p className="text-xs text-muted-foreground font-medium">Waiting for Data...</p>
          </div>
        </div>
      </div>

      {/* Series Browser Drawer */}
      <SeriesBrowser
        open={seriesBrowserOpen}
        onOpenChange={setSeriesBrowserOpen}
        registry={registry}
        visibleSeries={visibleSeries}
        onToggleSeries={handleToggleSeries}
        onSelectAll={handleSelectAllSeries}
        onSelectNone={handleSelectNoneSeries}
        plotLayout={plotLayout}
        onMoveSeries={handleMoveSeries}
      />

      {/* Command Palette (Ctrl/Cmd+K) */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onJumpToLive={handleJumpToLive}
        onToggleLive={handleToggleLive}
        onZoomExtents={zoomExtents}
        onToggleMinimap={() => setMinimapEnabled(!minimapEnabled)}
        onToggleTheme={handleToggleTheme}
        onLoadLayout={handleLoadLayout}
        onOpenSeriesBrowser={() => setSeriesBrowserOpen(true)}
        isLive={isLive}
        minimapEnabled={minimapEnabled}
        theme={theme}
      />
    </div>
  );
}
