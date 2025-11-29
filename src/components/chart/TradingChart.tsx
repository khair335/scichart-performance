import { useCallback, useState, useEffect, useMemo } from 'react';
import { useMultiPaneChart } from './MultiPaneChart';
import { useWebSocketFeed } from '@/hooks/useWebSocketFeed';
import { useDemoDataGenerator } from '@/hooks/useDemoDataGenerator';
import { HUD } from './HUD';
import { Toolbar } from './Toolbar';
import { SeriesBrowser } from './SeriesBrowser';
import { defaultChartConfig } from '@/types/chart';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play } from 'lucide-react';
import type { Sample, RegistryRow } from '@/lib/wsfeed-client';

interface TradingChartProps {
  wsUrl?: string;
  className?: string;
}

export function TradingChart({ wsUrl = 'ws://127.0.0.1:8765', className }: TradingChartProps) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [minimapEnabled, setMinimapEnabled] = useState(defaultChartConfig.minimap.enabled);
  const [seriesBrowserOpen, setSeriesBrowserOpen] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set());
  const [isLive, setIsLive] = useState(true);
  const [fps, setFps] = useState(0);
  const [dataClockMs, setDataClockMs] = useState(0);
  const [tickCount, setTickCount] = useState(0);
  const [demoMode, setDemoMode] = useState(false);
  const [demoRegistry, setDemoRegistry] = useState<RegistryRow[]>([]);

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

  // WebSocket feed
  const { state: feedState, registry: wsRegistry } = useWebSocketFeed({
    url: wsUrl,
    onSamples: handleSamples,
    autoConnect: !demoMode,
  });

  // Demo data generator
  useDemoDataGenerator({
    enabled: demoMode,
    ticksPerSecond: 50,
    basePrice: 6000,
    onSamples: handleSamples,
  });

  // Use appropriate registry based on mode
  const registry = demoMode ? demoRegistry : wsRegistry;

  // Auto-add discovered series to visible set
  useEffect(() => {
    if (registry.length > 0) {
      setVisibleSeries(prev => {
        const next = new Set(prev);
        for (const row of registry) {
          if (row.id.includes(':ticks') || row.id.includes(':sma_') || row.id.includes(':ohlc_')) {
            next.add(row.id);
          }
        }
        return next;
      });
    }
  }, [registry]);

  const handleToggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.classList.toggle('light', next === 'light');
      return next;
    });
  }, []);

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
    setVisibleSeries(prev => {
      const next = new Set(prev);
      if (next.has(seriesId)) {
        next.delete(seriesId);
      } else {
        next.add(seriesId);
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
        } catch (err) {
          console.error('Failed to load layout:', err);
        }
      }
    };
    input.click();
  }, []);

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
      />
    </div>
  );
}
