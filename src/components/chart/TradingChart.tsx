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
import { Play } from 'lucide-react';
import type { Sample, RegistryRow } from '@/lib/wsfeed-client';
import { parseSeriesType } from '@/lib/series-namespace';

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

  // Initialize multi-pane charts
  const {
    isReady,
    appendSamples,
    setLiveMode,
    zoomExtents,
    jumpToLive,
  } = useMultiPaneChart({
    tickContainerId: 'tick-chart',
    ohlcContainerId: 'ohlc-chart',
    overviewContainerId: minimapEnabled ? 'overview-chart' : undefined,
    onFpsUpdate: setFps,
    onDataClockUpdate: setDataClockMs,
    onReadyChange: () => {},
    onGpuUpdate: (drawCalls) => setGpuMetrics({ drawCalls, triangles: 0 }),
    visibleSeries,
    feedStage: demoMode ? 'demo' : feedState.stage,
    uiConfig: uiConfig,
    registry: registry, // Pass registry for global data clock calculation
  });

  // Handle samples from any source
  const handleSamples = useCallback((samples: Sample[]) => {
    appendSamples(samples);
    
    // Update tick count
    const newTicks = samples.filter(s => s.series_id.includes(':ticks')).length;
    setTickCount(prev => prev + newTicks);

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
  
  // Command palette keyboard shortcut (Ctrl/Cmd+K)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
  
  // Keep visibleSeries in sync with discovered series.
  // - On first load: turn ALL series ON by default.
  // - When new series appear later: add them as visible, but never re-toggle ones the user has changed.
  // - Respect "Clear All" action - don't auto-add series back if user cleared them
  useEffect(() => {
    if (registry.length === 0) return;
    
    setVisibleSeries(prev => {
      // Initial load: show price and indicators, but hide strategy series by default
      // Strategy series (PnL, signals, markers) have different Y-axis scales and can make price data appear tiny
      if (!hasInitializedRef.current && prev.size === 0) {
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

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.classList.toggle('light', next === 'light');
      return next;
    });
  }, []);

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

  const handleJumpToLive = useCallback(() => {
    setIsLive(true);
    setLiveMode(true);
    jumpToLive();
  }, [setLiveMode, jumpToLive]);

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
          const layout = JSON.parse(text);
          console.log('Layout loaded:', layout);
          
          // Apply the layout by activating the specified series
          if (layout.panes && Array.isArray(layout.panes)) {
            const seriesToActivate = new Set<string>();
            
            for (const pane of layout.panes) {
              if (pane.series && Array.isArray(pane.series)) {
                for (const seriesConfig of pane.series) {
                  if (seriesConfig.visible !== false && seriesConfig.seriesId) {
                    // Find matching series in registry (partial match)
                    const matchingSeries = registry.find(r => 
                      r.id.includes(seriesConfig.seriesId)
                    );
                    if (matchingSeries) {
                      seriesToActivate.add(matchingSeries.id);
                    }
                  }
                }
              }
            }
            
            if (seriesToActivate.size > 0) {
              setVisibleSeries(seriesToActivate);
              console.log(`Applied layout: ${seriesToActivate.size} series activated`);
            }
          }
        } catch (err) {
          console.error('Failed to load layout:', err);
          alert('Failed to load layout: ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    };
    input.click();
  }, [registry]);

  const handleStartDemo = useCallback(() => {
    setDemoMode(true);
    setTickCount(0);
    setDemoRegistry([]);
  }, []);

  const isConnected = demoMode || feedState.stage === 'live' || feedState.stage === 'history' || feedState.stage === 'delta';
  const currentStage = demoMode ? 'demo' : feedState.stage;

  return (
    <div className={cn('flex flex-col h-screen bg-background overflow-hidden', className)}>
      {/* Top Toolbar */}
      <Toolbar
        isLive={isLive}
        minimapEnabled={minimapEnabled}
        theme={theme}
        onJumpToLive={handleJumpToLive}
        onToggleLive={handleToggleLive}
        onZoomExtents={zoomExtents}
        onToggleMinimap={() => setMinimapEnabled(!minimapEnabled)}
        onToggleTheme={handleToggleTheme}
        onLoadLayout={handleLoadLayout}
        onOpenSeriesBrowser={() => setSeriesBrowserOpen(true)}
        className="shrink-0 border-b border-border"
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
        className="shrink-0 border-b border-border"
      />

      {/* Main Chart Area */}
      <div className="flex-1 min-h-0 flex flex-col relative">
        {/* Tick/Line Chart Pane */}
        <div className="relative flex-[6] min-h-0 border-b border-border">
          <div className="pane-title">Tick Price & Indicators</div>
          <div id="tick-chart" className="w-full h-full" />
        </div>

        {/* OHLC Candlestick Pane */}
        <div className="relative flex-[4] min-h-0">
          <div className="pane-title">OHLC Candlesticks</div>
          <div id="ohlc-chart" className="w-full h-full" />
        </div>

        {/* Connection Status Overlay */}
        {!isConnected && feedState.stage !== 'connecting' && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/95 backdrop-blur-sm z-30">
            <div className="text-center max-w-md px-6">
              <div className="w-16 h-16 rounded-full bg-destructive/20 flex items-center justify-center mx-auto mb-4">
                <span className="text-destructive text-3xl font-bold">!</span>
              </div>
              <h3 className="text-xl font-semibold text-foreground mb-2">No Data Connection</h3>
              <p className="text-sm text-muted-foreground mb-4">
                WebSocket server not available. Start the server or use demo mode.
              </p>
              <code className="text-xs text-muted-foreground font-mono bg-muted px-3 py-1.5 rounded block mb-4">
                {wsUrl}
              </code>
              
              <div className="flex flex-col gap-3">
                <Button 
                  onClick={handleStartDemo}
                  className="w-full bg-primary hover:bg-primary/90"
                >
                  <Play className="w-4 h-4 mr-2" />
                  Start Demo Mode
                </Button>
                <p className="text-xs text-muted-foreground">
                  Or run: <code className="bg-muted px-1.5 py-0.5 rounded">python server.py</code>
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Connecting Overlay */}
        {feedState.stage === 'connecting' && !demoMode && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/95 backdrop-blur-sm z-30">
            <div className="text-center">
              <div className="w-16 h-16 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-foreground mb-2">Connecting...</h3>
              <p className="text-sm text-muted-foreground">
                Establishing connection to data feed
              </p>
            </div>
          </div>
        )}

        {/* Chart Loading Overlay */}
        {!isReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-card/95 backdrop-blur-sm z-20">
            <div className="text-center">
              <div className="w-16 h-16 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
              <h3 className="text-xl font-semibold text-foreground mb-2">Initializing Chart</h3>
              <p className="text-sm text-muted-foreground">
                Loading SciChart WebAssembly engine...
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Overview/Minimap (when enabled) */}
      {minimapEnabled && (
        <div className="shrink-0 h-16 border-t border-border bg-card">
          <div id="overview-chart" className="w-full h-full" />
        </div>
      )}

      {/* Series Browser Drawer */}
      <SeriesBrowser
        open={seriesBrowserOpen}
        onOpenChange={setSeriesBrowserOpen}
        registry={registry}
        visibleSeries={visibleSeries}
        onToggleSeries={handleToggleSeries}
        onSelectAll={handleSelectAllSeries}
        onSelectNone={handleSelectNoneSeries}
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
