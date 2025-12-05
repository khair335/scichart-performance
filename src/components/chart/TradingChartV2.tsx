// TradingChartV2 - Layout-driven chart system
// Implements the complete pipeline: WS → SeriesStore → LayoutEngine → Charts

import { useCallback, useState, useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Play, Pause, Maximize, ZoomIn, Layout, Moon, Sun, List, RefreshCw, RotateCcw, Map as MapIcon, Command as CommandIcon, MoveHorizontal, MoveVertical, Maximize2, Square } from 'lucide-react';
import { HUD } from './HUD';
import { SeriesBrowser } from './SeriesBrowser';
import { DynamicPlotGrid } from './DynamicPlotGrid';
import { CommandPalette } from './CommandPalette';
import { Minimap } from './Minimap';
import { useIngestPipeline } from '@/hooks/useIngestPipeline';
import { useLayoutManager } from '@/hooks/useLayoutManager';
import { useDemoDataGenerator } from '@/hooks/useDemoDataGenerator';
import { useVisibilityThrottle } from '@/hooks/useVisibilityThrottle';
import { LayoutEngine } from '@/lib/layout-engine';
import { SeriesStore } from '@/lib/series-store';
import type { PlotLayoutJSON, UIConfig } from '@/types/layout';
import type { RegistryRow, Sample } from '@/lib/wsfeed-client';
import type { ZoomMode } from '@/types/zoom';
import { ZOOM_MODES, DEFAULT_ZOOM_MODE } from '@/types/zoom';

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
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [minimapEnabled, setMinimapEnabled] = useState(false);
  const [zoomMode, setZoomMode] = useState<ZoomMode>(DEFAULT_ZOOM_MODE);
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set());
  const [demoMode, setDemoMode] = useState(false);
  const [demoRegistry, setDemoRegistry] = useState<RegistryRow[]>([]);
  const [tickCount, setTickCount] = useState(0);
  
  // Tab visibility throttling
  const { isVisible, wasHidden } = useVisibilityThrottle({
    onVisible: () => console.log('[TradingChartV2] Tab became visible'),
    onHidden: () => console.log('[TradingChartV2] Tab hidden, throttling updates'),
  });
  
  // Configure SeriesStore from UI config
  useEffect(() => {
    if (uiConfig?.data?.buffers) {
      SeriesStore.configure({
        pointsPerSeries: uiConfig.data.buffers.pointsPerSeries,
        maxPointsTotal: uiConfig.data.buffers.maxPointsTotal,
      });
    }
  }, [uiConfig]);
  
  // Use the ingest pipeline (only when not in demo mode)
  const {
    stage,
    isConnected,
    stats,
    registry: wsRegistry,
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
  
  // Handle demo samples - append to SeriesStore
  const handleDemoSamples = useCallback((samples: Sample[]) => {
    // Append to SeriesStore (the source of truth)
    SeriesStore.appendSamples(samples);
    
    // Update tick count
    const newTicks = samples.filter(s => s.series_id.includes(':ticks')).length;
    setTickCount(prev => prev + newTicks);
    
    // Update demo registry
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
  }, []);
  
  // Demo data generator
  useDemoDataGenerator({
    enabled: demoMode,
    ticksPerSecond: 50,
    basePrice: 6000,
    onSamples: handleDemoSamples,
  });
  
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
  
  // Toggle minimap
  const handleToggleMinimap = useCallback(() => {
    setMinimapEnabled(prev => !prev);
  }, []);
  
  // Use appropriate registry
  const registry = demoMode ? demoRegistry : wsRegistry;
  
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
  
  // Zoom mode change
  const handleSetZoomMode = useCallback((mode: ZoomMode) => {
    setZoomMode(mode);
    LayoutEngine.setZoomMode(mode);
  }, []);
  
  // Load layout from file
  const handleLoadLayout = useCallback(async () => {
    await loadLayoutFromFile();
  }, [loadLayoutFromFile]);
  
  // Start demo mode
  const handleStartDemo = useCallback(() => {
    setDemoMode(true);
    setTickCount(0);
    setDemoRegistry([]);
    SeriesStore.clear();
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

  // Keyboard shortcuts (after handler definitions)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl/Cmd + K for command palette - check first before input check
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        setCommandPaletteOpen(true);
        return;
      }
      
      // Ignore if typing in input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      
      switch (e.key.toLowerCase()) {
        case 'j':
          handleJumpToLive();
          break;
        case 'z':
          handleZoomExtents();
          break;
        case 't':
          handleToggleTheme();
          break;
        case 'm':
          handleToggleMinimap();
          break;
        case 'f':
          document.documentElement.requestFullscreen?.();
          break;
        case ' ':
          e.preventDefault();
          handleToggleLive();
          break;
        case 's':
          setSeriesBrowserOpen(true);
          break;
        case 'l':
          handleLoadLayout();
          break;
        case 'escape':
          setCommandPaletteOpen(false);
          setSeriesBrowserOpen(false);
          break;
        // Zoom modes: 1-4
        case '1':
          handleSetZoomMode('xy');
          break;
        case '2':
          handleSetZoomMode('x');
          break;
        case '3':
          handleSetZoomMode('y');
          break;
        case '4':
          handleSetZoomMode('box');
          break;
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleJumpToLive, handleZoomExtents, handleToggleTheme, handleToggleMinimap, handleToggleLive, handleLoadLayout, handleSetZoomMode]);
  
  const showConnectionOverlay = !isConnected && stage !== 'connecting' && !demoMode;
  const showConnectingOverlay = stage === 'connecting' && !demoMode;
  const currentStage = demoMode ? 'demo' : stage;
  const currentRate = demoMode ? 50 : stats.samplesPerSecond;
  const currentPoints = demoMode ? tickCount : stats.totalPoints;
  
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
            title="Toggle Live/Pause (Space)"
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
          
          {/* Zoom Mode Selector */}
          <div className="flex items-center gap-0.5 ml-1 px-1 py-0.5 rounded bg-muted/50">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleSetZoomMode('xy')}
              className={cn('h-6 w-6 p-0', zoomMode === 'xy' && 'bg-accent text-accent-foreground')}
              title="XY Zoom (1)"
            >
              <Maximize2 className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleSetZoomMode('x')}
              className={cn('h-6 w-6 p-0', zoomMode === 'x' && 'bg-accent text-accent-foreground')}
              title="X-Only Zoom (2)"
            >
              <MoveHorizontal className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleSetZoomMode('y')}
              className={cn('h-6 w-6 p-0', zoomMode === 'y' && 'bg-accent text-accent-foreground')}
              title="Y-Only Zoom (3)"
            >
              <MoveVertical className="w-3 h-3" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => handleSetZoomMode('box')}
              className={cn('h-6 w-6 p-0', zoomMode === 'box' && 'bg-accent text-accent-foreground')}
              title="Box Zoom (4)"
            >
              <Square className="w-3 h-3" />
            </Button>
          </div>
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
        
        {/* Clear Layout */}
        {currentLayout && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearLayout}
            className="h-8 px-2 text-muted-foreground"
            title="Clear Layout"
          >
            <RotateCcw className="w-3 h-3" />
          </Button>
        )}
        
        {/* Current Layout Name */}
        {currentLayout?.meta?.name && (
          <span className="text-xs text-muted-foreground truncate max-w-40">
            {currentLayout.meta.name}
          </span>
        )}
        
        <div className="flex-1" />
        
        {/* Registry Count */}
        <span className="text-xs text-muted-foreground">
          {registry.length} series
        </span>
        
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
        
        {/* Minimap Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={handleToggleMinimap}
          className={cn('h-8 px-2', minimapEnabled && 'text-primary')}
          title="Toggle Minimap (M)"
        >
          <MapIcon className="w-4 h-4" />
        </Button>
        
        {/* Command Palette */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setCommandPaletteOpen(true)}
          className="h-8 px-2"
          title="Command Palette (Ctrl+K)"
        >
          <CommandIcon className="w-4 h-4" />
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
        stage={currentStage}
        rate={currentRate}
        fps={fps}
        heartbeatLag={status?.heartbeatLagMs ?? null}
        dataClockMs={dataClockMs}
        isLive={isLive}
        historyProgress={status?.history?.pct ?? 100}
        tickCount={currentPoints}
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
      
      {/* Minimap */}
      <Minimap 
        enabled={minimapEnabled} 
        sourceSeriesId={currentLayout?.minimap?.source?.series_id}
      />
      
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
      
      {/* Command Palette */}
      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={setCommandPaletteOpen}
        onJumpToLive={handleJumpToLive}
        onToggleLive={handleToggleLive}
        onZoomExtents={handleZoomExtents}
        onToggleMinimap={handleToggleMinimap}
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
