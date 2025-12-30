import { useCallback, useState, useEffect, useMemo, useRef } from 'react';
import { useMultiPaneChart } from './MultiPaneChart';
import { useWebSocketFeed } from '@/hooks/useWebSocketFeed';
import { useDemoDataGenerator } from '@/hooks/useDemoDataGenerator';
import { HUD } from './HUD';
import { Toolbar } from './Toolbar';
import { ConnectionControls, type CursorPolicy, type WireFormat } from './ConnectionControls';
import { SeriesBrowser } from './SeriesBrowser';
import { CommandPalette } from './CommandPalette';
import { FloatingMinimap } from './FloatingMinimap';
import { defaultChartConfig } from '@/types/chart';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play, X, Grid3x3, FileJson } from 'lucide-react';
import type { Sample, RegistryRow } from '@/lib/wsfeed-client';
import { parseSeriesType } from '@/lib/series-namespace';
import { parsePlotLayout, getDefaultLayout, type ParsedLayout } from '@/types/plot-layout';
import { DynamicPlotGrid } from './DynamicPlotGrid';
import { sharedDataSeriesPool } from '@/lib/shared-data-series-pool';

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
    <div className="absolute inset-0 flex items-start justify-center z-30">
      <div className="absolute inset-0 bg-gradient-to-br from-background/95 via-background/90 to-background/95 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
      <div className="relative text-center max-w-md px-8 py-10 glass-card fade-in mt-10">
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
    <div className="absolute inset-0 flex items-start justify-center z-30">
      <div className="absolute inset-0 bg-gradient-to-br from-background/98 via-background/99 to-background/100 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
      <div className="relative text-center max-w-md px-8 py-10 glass-card fade-in mt-10">
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
        
      
      </div>
    </div>
  );
};

interface TradingChartProps {
  wsUrl?: string;
  className?: string;
  uiConfig?: any;
}

export function TradingChart({ wsUrl: initialWsUrl = 'ws://127.0.0.1:8765', className, uiConfig }: TradingChartProps) {
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
  const [toolbarVisible, setToolbarVisible] = useState(true);
  const [connectionControlsVisible, setConnectionControlsVisible] = useState(true);
  const [zoomMode, setZoomMode] = useState<'box' | 'x-only' | 'y-only'>('box');
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [cursorEnabled, setCursorEnabled] = useState(false);
  const [legendsEnabled, setLegendsEnabled] = useState(false);
  
  // Connection settings state
  const [wsUrl, setWsUrl] = useState(initialWsUrl);
  const [cursorPolicy, setCursorPolicy] = useState<CursorPolicy>('auto');
  const [wireFormat, setWireFormat] = useState<WireFormat>('auto');
  const [autoReconnect, setAutoReconnect] = useState(true);
  const [useLocalStorage, setUseLocalStorage] = useState(true);
  
  // Plot layout state
  const [plotLayout, setPlotLayout] = useState<ParsedLayout | null>(null);
  const [currentLayoutName, setCurrentLayoutName] = useState<string | null>(null);
  const [layoutError, setLayoutError] = useState<string | null>(null);
  const [layoutHistory, setLayoutHistory] = useState<Array<{ name: string; path?: string; layoutJson?: any; loadedAt: number }>>([]);
  
  // Time window presets from config
  const [timeWindowPresets, setTimeWindowPresets] = useState<Array<{ label: string; minutes: number }>>([
    { label: 'Last 15 min', minutes: 15 },
    { label: 'Last 30 min', minutes: 30 },
    { label: 'Last 1 hour', minutes: 60 },
    { label: 'Last 4 hours', minutes: 240 },
  ]);
  
  // Track current time window selection
  const [currentTimeWindow, setCurrentTimeWindow] = useState<{ minutes: number; startTime: number; endTime: number } | null>(null);
  
  // Auto-hide configuration
  const [autoHideEnabled, setAutoHideEnabled] = useState(false);
  const [autoHideDelayMs, setAutoHideDelayMs] = useState(3000);
  const autoHideTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  
  // Performance metrics for HUD
  const [cpuUsage, setCpuUsage] = useState(0);
  const [memoryUsage, setMemoryUsage] = useState(0);
  const [gpuMetrics, setGpuMetrics] = useState({ drawCalls: 0, triangles: 0 });

  // Handle samples from any source - defined early so it can be used in useWebSocketFeed
  const handleSamplesRef = useRef<(samples: Sample[]) => void>(() => {});
  
  // Session complete handler - auto-pause when server finishes
  const handleSessionComplete = useCallback(() => {
    console.log('[TradingChart] Session complete - auto-pausing for manual exploration');
    setIsLive(false);
  }, []);
  
  // WebSocket feed - must be called before useMultiPaneChart to get feedState
  const { 
    state: feedState, 
    registry: wsRegistry, 
    connect: wsConnect, 
    disconnect: wsDisconnect, 
    resetCursor: wsResetCursor,
    setCursorPolicy: wsSetCursorPolicy,
  } = useWebSocketFeed({
    url: wsUrl,
    onSamples: (samples) => handleSamplesRef.current(samples),
    onSessionComplete: handleSessionComplete,
    autoConnect: !demoMode,
    cursorPolicy: cursorPolicy as any,
    useLocalStorage,
    autoReconnect,
  });
  
  // Handler for cursor policy change - updates both local state and client
  const handleCursorPolicyChange = useCallback((policy: CursorPolicy) => {
    setCursorPolicy(policy);
    wsSetCursorPolicy(policy as any);
  }, [wsSetCursorPolicy]);

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
        
        // Load UI settings from config
        if (config.ui && mounted) {
          // Auto-hide settings
          if (config.ui.autoHide) {
            setAutoHideEnabled(config.ui.autoHide.enabled ?? false);
            setAutoHideDelayMs(config.ui.autoHide.delayMs ?? 3000);
          }
          // Time window presets
          if (config.ui.timeWindowPresets && Array.isArray(config.ui.timeWindowPresets)) {
            setTimeWindowPresets(config.ui.timeWindowPresets);
          }
        }

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
              // Add to layout history
              setLayoutHistory(prev => {
                const newEntry = { name: filename, path: config.defaultLayoutPath, loadedAt: Date.now() };
                // Avoid duplicates
                const filtered = prev.filter(e => e.name !== filename);
                return [newEntry, ...filtered].slice(0, 10);
              });

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
    setTimeWindow,
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
    onTimeWindowChanged: (window) => {
      // Sync Toolbar display when time window changes (from minimap or setTimeWindow)
      if (window) {
        setCurrentTimeWindow(window);
      } else {
        setCurrentTimeWindow(null);
      }
    },
    onAutoScrollChange: (enabled) => {
      // Sync HUD auto-scroll status with actual auto-scroll state
      setIsLive(enabled);
    },
    plotLayout: plotLayout, // Pass parsed layout
    zoomMode: zoomMode, // Pass zoom mode
    theme: theme, // Pass theme for chart surfaces
    cursorEnabled: cursorEnabled, // Pass cursor enabled state
    legendsEnabled: legendsEnabled, // Pass legends enabled state
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

  // Auto-hide UI effect
  useEffect(() => {
    if (!autoHideEnabled) {
      setHudVisible(true);
      setToolbarVisible(true);
      return;
    }

    const handleActivity = () => {
      lastActivityRef.current = Date.now();
      setHudVisible(true);
      setToolbarVisible(true);
      
      // Clear existing timer
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
      }
      
      // Set new timer
      autoHideTimerRef.current = setTimeout(() => {
        setHudVisible(false);
        setToolbarVisible(false);
      }, autoHideDelayMs);
    };

    // Initial timer
    handleActivity();

    // Add event listeners
    window.addEventListener('mousemove', handleActivity);
    window.addEventListener('mousedown', handleActivity);
    window.addEventListener('keydown', handleActivity);
    window.addEventListener('scroll', handleActivity);

    return () => {
      window.removeEventListener('mousemove', handleActivity);
      window.removeEventListener('mousedown', handleActivity);
      window.removeEventListener('keydown', handleActivity);
      window.removeEventListener('scroll', handleActivity);
      if (autoHideTimerRef.current) {
        clearTimeout(autoHideTimerRef.current);
      }
    };
  }, [autoHideEnabled, autoHideDelayMs]);

  // Calculate gap metrics from registry
  const gapMetrics = useMemo(() => {
    let totalGaps = 0;
    let initGap = 0;
    const seriesGaps: Array<{ id: string; gaps: number; missed: number }> = [];

    for (const row of registry) {
      totalGaps += row.gaps || 0;
      const seriesMissed = row.missed || 0;
      if (row.gaps > 0 || seriesMissed > 0) {
        seriesGaps.push({ id: row.id, gaps: row.gaps || 0, missed: seriesMissed });
      }
    }

    // InitGap: gaps detected during initial history load
    // This would need to be tracked separately during init_begin -> init_complete phase
    // For now, we'll estimate based on first tick series
    const firstTickSeries = registry.find(r => r.id.includes(':ticks'));
    if (firstTickSeries && firstTickSeries.firstSeriesSeq !== null && firstTickSeries.firstSeriesSeq > 0) {
      initGap = firstTickSeries.firstSeriesSeq;
    }

    return { totalGaps, initGap, seriesGaps };
  }, [registry]);

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
      // Initial load: show ALL series by default, including strategy markers
      // REQUIREMENT: Strategy markers must appear initially along with other series
      // Strategy markers are rendered as annotations (not regular series), so they're always visible
      // But we still need to include them in visibleSeries for consistency
      // CRITICAL: Initialize even if hasInitializedRef is true IF prev.size is 0 and registry has data
      // This handles the case where registry wasn't populated during first initialization
      if (prev.size === 0 && (!hasInitializedRef.current || registry.length > 0)) {
        hasInitializedRef.current = true;
        // Show ALL series by default, including strategy markers
        // Strategy markers are rendered as annotations, but we include them here for consistency
        const visible = new Set(registry.map(r => r.id));
        console.log(`[TradingChart] 🔄 Initializing visibleSeries with ${visible.size} series from registry of ${registry.length} (including strategy markers)`);
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
          
          // Add to layout history (store the JSON content for file-loaded layouts)
          setLayoutHistory(prev => {
            const newEntry = { name: layoutName, layoutJson, loadedAt: Date.now() };
            const filtered = prev.filter(e => e.name !== layoutName);
            return [newEntry, ...filtered].slice(0, 10);
          });
          
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

  // Handle time window selection - controls minimap selection width
  // When a preset is selected, minimap enters "sticky" mode (right edge follows live data)
  const handleTimeWindowSelect = useCallback((minutes: number) => {
    if (minutes === 0) {
      // Entire session - show all data and keep live mode for continuous expansion
      setTimeWindow(0, dataClockMs || Date.now()); // Pass 0 to trigger session mode
      // CRITICAL: Keep live mode enabled so chart expands with new data
      // setIsLive(false); // Removed - allow live updates for entire session
      setCurrentTimeWindow(null); // Clear window display for "Entire Session"
    } else {
      // Set minimap to show last N minutes; charts remain paused until
      // user explicitly drags minimap to the right edge to enable
      // sticky live-follow behaviour.
      const clockMs = dataClockMs || Date.now();
      const windowMs = minutes * 60 * 1000;
      const endTime = clockMs;
      const startTime = endTime - windowMs;
      console.log(`[TradingChart] Setting time window: ${minutes} min, range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
      setTimeWindow(minutes, clockMs);
      // CRITICAL: Don't pause live mode - allow the window to continuously update
      // The window will show the last X minutes from the latest data as new data arrives
      // setIsLive(false); // Removed - allow live updates for selected window
      setCurrentTimeWindow({ minutes, startTime, endTime });
    }
  }, [dataClockMs, setTimeWindow]);
  
  // NOTE: Removed the continuous update of currentTimeWindow display
  // The Toolbar now shows just the preset label (e.g., "Last 15 min") instead of the time range
  // This prevents unnecessary re-renders and makes the UI cleaner

  // Handle loading layout from history
  const handleLoadHistoryLayout = useCallback(async (entry: { name: string; path?: string; layoutJson?: any; loadedAt: number }) => {
    try {
      let layoutJson: any;
      
      if (entry.path) {
        // Fetch from path (public/layouts/ files)
        const layoutResponse = await fetch(entry.path);
        if (!layoutResponse.ok) {
          throw new Error(`Failed to fetch layout: ${layoutResponse.statusText}`);
        }
        layoutJson = await layoutResponse.json();
      } else if (entry.layoutJson) {
        // Use cached JSON content (file-loaded layouts)
        layoutJson = entry.layoutJson;
      } else {
        // No path and no cached JSON - shouldn't happen, but handle gracefully
        console.warn('[TradingChart] Layout history entry has no path or cached JSON:', entry.name);
        return;
      }
      
      const parsed = parsePlotLayout(layoutJson);
      
      setPlotLayout(parsed);
      setCurrentLayoutName(entry.name);
      setLayoutError(null);
      
      // Move to front of history
      setLayoutHistory(prev => {
        const filtered = prev.filter(e => e.name !== entry.name);
        return [{ ...entry, loadedAt: Date.now() }, ...filtered].slice(0, 10);
      });
    } catch (err) {
      console.error('[TradingChart] Failed to load layout from history:', err);
      alert(`Failed to load layout: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, []);

  // Treat sessionComplete as a "connected" final state to avoid auto-reload overlays
  // Also include 'connecting' as a valid state to avoid showing overlay during connection attempts
  const isConnected = demoMode || feedState.sessionComplete || feedState.stage === 'live' || feedState.stage === 'history' || feedState.stage === 'delta' || feedState.stage === 'complete' || feedState.stage === 'connecting';
  const currentStage = demoMode ? 'demo' : feedState.stage;
  
  // Check if min_height is set in layout (if > 0, remove overflow-hidden to allow scrolling)
  const minHeightValue = plotLayout?.layout.min_height ?? 0;
  const hasMinHeight = minHeightValue > 0;

  // Ensure the page can scroll when a layout requests a minimum height
  // Use minHeightValue in dependency to catch changes even if plotLayout reference changes
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
  }, [hasMinHeight, minHeightValue]);

  return (
    <div className={cn('flex flex-col relative', hasMinHeight ? 'min-h-screen overflow-y-auto overflow-x-hidden' : 'h-screen overflow-hidden', className)}>
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
        zoomMode={zoomMode}
        onZoomModeChange={setZoomMode}
        timeWindowPresets={timeWindowPresets}
        onTimeWindowSelect={handleTimeWindowSelect}
        currentTimeWindow={currentTimeWindow}
        defaultTimeWindow={plotLayout?.xAxisDefaultRange || null}
        layoutHistory={layoutHistory}
        onLoadHistoryLayout={handleLoadHistoryLayout}
        visible={toolbarVisible}
        cursorEnabled={cursorEnabled}
        onToggleCursor={() => setCursorEnabled(!cursorEnabled)}
        legendsEnabled={legendsEnabled}
        onToggleLegends={() => setLegendsEnabled(!legendsEnabled)}
        className={cn(
          "shrink-0 border-b border-border transition-opacity duration-300",
          !toolbarVisible && "opacity-0 pointer-events-none"
        )}
      />

      {/* HUD Status Bar */}
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
        totalGaps={gapMetrics.totalGaps}
        initGap={gapMetrics.initGap}
        seriesGaps={gapMetrics.seriesGaps}
        visible={hudVisible}
        className={cn(
          "shrink-0 border-b border-border transition-opacity duration-300",
          !hudVisible && "opacity-0 pointer-events-none"
        )}
      />

      {/* Connection Controls Panel */}
      <ConnectionControls
        wsUrl={wsUrl}
        onWsUrlChange={setWsUrl}
        cursorPolicy={cursorPolicy}
        onCursorPolicyChange={handleCursorPolicyChange}
        wireFormat={wireFormat}
        onWireFormatChange={setWireFormat}
        autoReconnect={autoReconnect}
        onAutoReconnectChange={setAutoReconnect}
        useLocalStorage={useLocalStorage}
        onUseLocalStorageChange={setUseLocalStorage}
        onConnect={wsConnect}
        onDisconnect={wsDisconnect}
        onResetCursor={() => {
          // Clear all chart data before resetting cursor to avoid duplicate/overlapping lines
          sharedDataSeriesPool.clearAllData();
          wsResetCursor(true);
        }}
        isConnected={feedState.connected}
        isConnecting={feedState.stage === 'connecting'}
        stage={feedState.stage}
        lastSeq={feedState.lastSeq}
        heartbeatLag={feedState.heartbeatLag}
        rate={feedState.rate}
        gaps={feedState.gaps}
        wireFormatActive={feedState.wireFormat}
        visible={connectionControlsVisible}
        className="shrink-0 border-b border-border"
      />

      {/* Main Chart Area */}
      {/* When hasMinHeight, allow container to grow beyond flex-1 by using min-h-0 auto and removing flex-1 constraint */}
      <div 
        className={cn(
          'flex flex-col relative z-10',
          hasMinHeight ? 'flex-none overflow-visible' : 'flex-1 min-h-0 overflow-hidden'
        )}
        style={hasMinHeight && minHeightValue ? { minHeight: `${minHeightValue}px` } : undefined}
      >
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

        {/* Connection Status Overlay - Only show when truly disconnected (not connecting) */}
        {!isConnected && feedState.stage !== 'connecting' && feedState.stage !== 'idle' && (
          <NoConnectionOverlay
            wsUrl={wsUrl}
            onStartDemo={handleStartDemo}
            autoReloadEnabled={autoReloadEnabled}
            onCancelAutoReload={() => setAutoReloadEnabled(false)}
          />
        )}

        {/* Connecting Overlay */}
        {feedState.stage === 'connecting' && !demoMode && (
          <div className="absolute inset-0 flex items-start justify-center z-30">
            <div className="absolute inset-0 bg-gradient-to-br from-background/98 via-background/99 to-background/100 dark:from-background/95 dark:via-background/90 dark:to-background/95 backdrop-blur-xl" />
            <div className="relative text-center glass-card px-8 py-10 fade-in mt-10">
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

      {/* Floating Minimap (draggable) */}
      <FloatingMinimap
        visible={minimapEnabled}
        onClose={() => setMinimapEnabled(false)}
        defaultPosition={{ x: 0, y: window.innerHeight - 140 }}
        defaultSize={{ width: window.innerWidth - 15, height: 140 }}
      >
        <div id="overview-chart" className="w-full h-full" />
      </FloatingMinimap>


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
