// TradingChartV2 - Layout-driven chart system
// This version implements the complete pipeline architecture

import { useCallback, useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play, Pause, Maximize, ZoomIn, Layout, Moon, Sun, List, Command, RefreshCw } from 'lucide-react';
import { HUD } from './HUD';
import { SeriesBrowser } from './SeriesBrowser';
import { DynamicPlotGrid } from './DynamicPlotGrid';
import { useIngestPipeline } from '@/hooks/useIngestPipeline';
import { useLayoutManager } from '@/hooks/useLayoutManager';
import { LayoutEngine } from '@/lib/layout-engine';
import { SeriesStore } from '@/lib/series-store';
import type { PlotLayoutJSON, UIConfig } from '@/types/layout';
import type { RegistryRow } from '@/lib/wsfeed-client';

interface TradingChartV2Props {
  wsUrl?: string;
  className?: string;
  uiConfig?: UIConfig;
}

export function TradingChartV2({ 
  wsUrl = 'ws://127.0.0.1:8765', 
  className,
  uiConfig 
}: TradingChartV2Props) {
  const [theme, setTheme] = useState<'dark' | 'light'>(uiConfig?.ui?.theme?.default || 'dark');
  const [isLive, setIsLive] = useState(true);
  const [fps, setFps] = useState(0);
  const [dataClockMs, setDataClockMs] = useState(0);
  const [seriesBrowserOpen, setSeriesBrowserOpen] = useState(false);
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set());
  const [demoMode, setDemoMode] = useState(false);
  
  // Use the new ingest pipeline
  const {
    stage,
    isConnected,
    stats,
    registry,
    connect,
    disconnect,
    status,
  } = useIngestPipeline({
    wsUrl,
    uiConfig,
    autoConnect: !demoMode,
  });
  
  // Use layout manager
  const {
    currentLayout,
    layoutHistory,
    isLoading: layoutLoading,
    errors: layoutErrors,
    loadLayout,
    loadLayoutFromFile,
    clearLayout,
  } = useLayoutManager({ uiConfig });
  
  // FPS counter
  const fpsCounterRef = useRef({ frameCount: 0, lastTime: performance.now() });
  
  useEffect(() => {
    let animId: number;
    
    const updateFps = () => {
      fpsCounterRef.current.frameCount++;
      const now = performance.now();
      const elapsed = now - fpsCounterRef.current.lastTime;
      
      if (elapsed >= 1000) {
        setFps(Math.round((fpsCounterRef.current.frameCount / elapsed) * 1000));
        fpsCounterRef.current.frameCount = 0;
        fpsCounterRef.current.lastTime = now;
      }
      
      animId = requestAnimationFrame(updateFps);
    };
    
    animId = requestAnimationFrame(updateFps);
    return () => cancelAnimationFrame(animId);
  }, []);
  
  // Update data clock from SeriesStore
  useEffect(() => {
    const unsubscribe = SeriesStore.subscribe((entries) => {
      let maxTime = 0;
      for (const entry of entries.values()) {
        if (entry.metadata.lastMs > maxTime) {
          maxTime = entry.metadata.lastMs;
        }
      }
      setDataClockMs(maxTime);
    });
    
    return unsubscribe;
  }, []);
  
  // Theme toggle
  const handleToggleTheme = useCallback(() => {
    setTheme(prev => {
      const next = prev === 'dark' ? 'light' : 'dark';
      document.documentElement.classList.toggle('dark', next === 'dark');
      document.documentElement.classList.toggle('light', next === 'light');
      return next;
    });
  }, []);
  
  // Live/Pause toggle
  const handleToggleLive = useCallback(() => {
    setIsLive(prev => !prev);
  }, []);
  
  // Jump to live
  const handleJumpToLive = useCallback(() => {
    setIsLive(true);
    LayoutEngine.jumpToLive();
  }, []);
  
  // Zoom extents
  const handleZoomExtents = useCallback(() => {
    LayoutEngine.zoomExtents();
    setIsLive(false);
  }, []);
  
  // Load layout from file
  const handleLoadLayout = useCallback(async () => {
    await loadLayoutFromFile();
  }, [loadLayoutFromFile]);
  
  // Start demo mode
  const handleStartDemo = useCallback(() => {
    setDemoMode(true);
    // Demo mode will be handled by useDemoDataGenerator
  }, []);
  
  // Series visibility
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
  
  const handleSelectAllSeries = useCallback(() => {
    setVisibleSeries(new Set(registry.map(r => r.id)));
  }, [registry]);
  
  const handleSelectNoneSeries = useCallback(() => {
    setVisibleSeries(new Set());
  }, []);
  
  // Convert registry to expected format
  const registryForBrowser: RegistryRow[] = registry;
  
  const showConnectionOverlay = !isConnected && stage !== 'connecting' && !demoMode;
  const showConnectingOverlay = stage === 'connecting' && !demoMode;
  
  return (
    <div className={cn('flex flex-col h-screen bg-background overflow-hidden', className)}>
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-4 py-2 bg-card border-b border-border shrink-0">
        <div className="flex items-center gap-1">
          {/* Live/Pause */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleToggleLive}
            className={cn(
              'h-8 px-2',
              isLive ? 'text-green-500' : 'text-yellow-500'
            )}
          >
            {isLive ? <Play className="w-4 h-4" /> : <Pause className="w-4 h-4" />}
            <span className="ml-1 text-xs">{isLive ? 'LIVE' : 'PAUSED'}</span>
          </Button>
          
          {/* Jump to Live */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleJumpToLive}
            className="h-8 px-2"
            title="Jump to Live (J)"
          >
            <RefreshCw className="w-4 h-4" />
          </Button>
          
          {/* Zoom Extents */}
          <Button
            variant="ghost"
            size="sm"
            onClick={handleZoomExtents}
            className="h-8 px-2"
            title="Zoom Extents (Z)"
          >
            <ZoomIn className="w-4 h-4" />
          </Button>
        </div>
        
        <div className="w-px h-6 bg-border" />
        
        {/* Load Layout */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleLoadLayout}
          className="h-8 px-2"
          title="Load Layout JSON"
        >
          <Layout className="w-4 h-4" />
          <span className="ml-1 text-xs">Layout</span>
        </Button>
        
        {/* Current Layout Name */}
        {currentLayout?.meta?.name && (
          <span className="text-xs text-muted-foreground truncate max-w-32">
            {currentLayout.meta.name}
          </span>
        )}
        
        <div className="flex-1" />
        
        {/* Series Browser */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSeriesBrowserOpen(true)}
          className="h-8 px-2"
          title="Series Browser"
        >
          <List className="w-4 h-4" />
        </Button>
        
        {/* Theme Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggleTheme}
          className="h-8 px-2"
          title="Toggle Theme (T)"
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
        
        {/* Fullscreen */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => document.documentElement.requestFullscreen?.()}
          className="h-8 px-2"
          title="Fullscreen (F)"
        >
          <Maximize className="w-4 h-4" />
        </Button>
      </div>
      
      {/* HUD */}
      <HUD
        stage={demoMode ? 'demo' : stage}
        rate={stats.samplesPerSecond}
        fps={fps}
        heartbeatLag={status?.heartbeatLagMs ?? null}
        dataClockMs={dataClockMs}
        isLive={isLive}
        historyProgress={status?.history?.pct ?? 100}
        tickCount={stats.totalPoints}
        cpuUsage={0}
        memoryUsage={0}
        gpuDrawCalls={0}
        className="shrink-0 border-b border-border"
      />
      
      {/* Main Chart Area */}
      <div className="flex-1 min-h-0 relative">
        <DynamicPlotGrid
          layout={currentLayout}
          onLayoutLoaded={() => console.log('[TradingChartV2] Layout loaded')}
          onError={(errors) => console.error('[TradingChartV2] Layout errors:', errors)}
          className="h-full"
        />
        
        {/* Connection Status Overlay */}
        {showConnectionOverlay && (
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
        {showConnectingOverlay && (
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
      </div>
      
      {/* Series Browser Drawer */}
      <SeriesBrowser
        open={seriesBrowserOpen}
        onOpenChange={setSeriesBrowserOpen}
        registry={registryForBrowser}
        visibleSeries={visibleSeries}
        onToggleSeries={handleToggleSeries}
        onSelectAll={handleSelectAllSeries}
        onSelectNone={handleSelectNoneSeries}
      />
    </div>
  );
}
