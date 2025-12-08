import { cn } from '@/lib/utils';

interface HUDProps {
  stage: string;
  rate: number;
  fps: number;
  heartbeatLag: number | null;
  dataClockMs: number;
  isLive: boolean;
  historyProgress: number;
  tickCount: number;
  cpuUsage?: number;
  memoryUsage?: number;
  gpuDrawCalls?: number;
  currentLayoutName?: string | null;
  onReloadLayout?: () => void;
  seriesCount?: number;
  minimapEnabled?: boolean;
  onToggleMinimap?: () => void;
  theme?: 'dark' | 'light';
  onToggleTheme?: () => void;
  onOpenCommandPalette?: () => void;
  onToggleFullscreen?: () => void;
  isFullscreen?: boolean;
  className?: string;
}

export function HUD({
  stage,
  rate,
  fps,
  heartbeatLag,
  dataClockMs,
  isLive,
  historyProgress,
  tickCount,
  cpuUsage = 0,
  memoryUsage = 0,
  gpuDrawCalls = 0,
  className,
}: HUDProps) {
  const formatTime = (ms: number) => {
    if (!ms || !Number.isFinite(ms)) return '--:--:--';
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').slice(11, 19);
  };

  const formatDataClock = (ms: number) => {
    if (!ms || !Number.isFinite(ms)) return '----/--/-- --:--:--';
    const d = new Date(ms);
    return d.toISOString().replace('T', ' ').slice(0, 19);
  };

  const getStatusPill = () => {
    switch (stage.toLowerCase()) {
      case 'live':
        return (
          <span className="status-pill status-pill-live animate-pulse-subtle">
            <span className="w-1.5 h-1.5 bg-success rounded-full mr-1.5 glow-success" />
            LIVE
          </span>
        );
      case 'demo':
        return (
          <span className="status-pill bg-primary/20 text-primary animate-pulse-subtle">
            <span className="w-1.5 h-1.5 bg-primary rounded-full mr-1.5 glow-primary" />
            DEMO
          </span>
        );
      case 'history':
      case 'delta':
        return (
          <span className="status-pill status-pill-history">
            <span className="w-1.5 h-1.5 bg-warning rounded-full mr-1.5" />
            {stage.toUpperCase()} {historyProgress}%
          </span>
        );
      case 'connecting':
        return (
          <span className="status-pill bg-muted text-muted-foreground">
            <span className="w-1.5 h-1.5 bg-muted-foreground rounded-full mr-1.5 animate-pulse" />
            CONNECTING
          </span>
        );
      case 'error':
      case 'closed':
        return (
          <span className="status-pill status-pill-error">
            <span className="w-1.5 h-1.5 bg-destructive rounded-full mr-1.5" />
            {stage.toUpperCase()}
          </span>
        );
      default:
        return (
          <span className="status-pill bg-muted text-muted-foreground">
            {stage.toUpperCase() || 'IDLE'}
          </span>
        );
    }
  };

  const getFpsColor = () => {
    if (fps >= 55) return 'text-success';
    if (fps >= 30) return 'text-warning';
    return 'text-destructive';
  };

  return (
    <div className={cn('hud-panel px-4 py-2.5 flex items-center gap-4 mono-data text-xs', className)}>
      {/* Status */}
      {getStatusPill()}

      <div className="w-px h-6 bg-border/60" />

      {/* Data Clock */}
      <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-muted/20 border border-border/30">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Clock</span>
        <span className="text-primary font-semibold">{formatDataClock(dataClockMs)}</span>
      </div>

      {/* FPS */}
      <div className={cn(
        'flex items-center gap-2 px-2 py-1 rounded-lg border transition-all',
        getFpsColor() === 'text-success' ? 'bg-success/10 border-success/30' :
        getFpsColor() === 'text-warning' ? 'bg-warning/10 border-warning/30' :
        'bg-destructive/10 border-destructive/30'
      )}>
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">FPS</span>
        <span className={cn('font-bold', getFpsColor())}>{fps}</span>
      </div>

      {/* Rate */}
      <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-muted/20 border border-border/30">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Rate</span>
        <span className="text-foreground font-semibold">{rate.toFixed(0)}/s</span>
      </div>

      {/* Heartbeat Lag */}
      <div className={cn(
        'flex items-center gap-2 px-2 py-1 rounded-lg border',
        heartbeatLag !== null && heartbeatLag > 1000 
          ? 'bg-warning/10 border-warning/30' 
          : 'bg-muted/20 border-border/30'
      )}>
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Lag</span>
        <span className={cn(
          'font-semibold',
          heartbeatLag !== null && heartbeatLag > 1000 ? 'text-warning' : 'text-foreground'
        )}>
          {heartbeatLag !== null ? `${heartbeatLag}ms` : '—'}
        </span>
      </div>

      {/* Tick Count */}
      <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-muted/20 border border-border/30">
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Ticks</span>
        <span className="text-foreground font-semibold">{tickCount.toLocaleString()}</span>
      </div>

      {/* CPU Usage */}
      {cpuUsage > 0 && (
        <div className={cn(
          'flex items-center gap-2 px-2 py-1 rounded-lg border',
          cpuUsage > 80 ? 'bg-destructive/10 border-destructive/30' :
          cpuUsage > 50 ? 'bg-warning/10 border-warning/30' :
          'bg-success/10 border-success/30'
        )}>
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">CPU</span>
          <span className={cn(
            'font-bold',
            cpuUsage > 80 ? 'text-destructive' : cpuUsage > 50 ? 'text-warning' : 'text-success'
          )}>
            {cpuUsage.toFixed(0)}%
          </span>
        </div>
      )}

      {/* Memory Usage */}
      {memoryUsage > 0 && (
        <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-muted/20 border border-border/30">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Mem</span>
          <span className="text-foreground font-semibold">{memoryUsage.toFixed(0)}MB</span>
        </div>
      )}

      {/* GPU Draw Calls */}
      {gpuDrawCalls > 0 && (
        <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-muted/20 border border-border/30">
          <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">GPU</span>
          <span className="text-foreground font-semibold">{gpuDrawCalls}</span>
        </div>
      )}

      <div className="flex-1" />

      {/* Live/Paused indicator */}
      <div className={cn(
        'px-3 py-1.5 rounded-lg border font-semibold text-xs transition-all',
        isLive 
          ? 'bg-success/20 border-success/40 text-success' 
          : 'bg-muted/30 border-border/50 text-muted-foreground'
      )}>
        {isLive ? (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-success rounded-full animate-pulse glow-success" />
            AUTO-SCROLL
          </span>
        ) : (
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 bg-muted-foreground rounded-full" />
            PAUSED
          </span>
        )}
      </div>
    </div>
  );
}
