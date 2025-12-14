import { cn } from '@/lib/utils';

interface SeriesGapInfo {
  id: string;
  gaps: number;
  missed: number;
}

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
  // Gap metrics
  totalGaps?: number;
  initGap?: number;
  seriesGaps?: SeriesGapInfo[];
  visible?: boolean;
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
  totalGaps = 0,
  initGap = 0,
  seriesGaps = [],
  visible = true,
}: HUDProps) {
  if (!visible) return null;
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
      case 'complete':
        return (
          <span className="status-pill bg-primary/20 text-primary">
            <span className="w-1.5 h-1.5 bg-primary rounded-full mr-1.5 glow-primary" />
            SESSION COMPLETE
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

      {/* Gaps */}
      <div className={cn(
        'flex items-center gap-2 px-2 py-1 rounded-lg border group relative',
        totalGaps > 10 ? 'bg-destructive/10 border-destructive/30' :
        totalGaps > 0 ? 'bg-warning/10 border-warning/30' :
        'bg-muted/20 border-border/30'
      )}>
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">Gaps</span>
        <span className={cn(
          'font-bold',
          totalGaps > 10 ? 'text-destructive' : totalGaps > 0 ? 'text-warning' : 'text-foreground'
        )}>
          {totalGaps}
        </span>
        {/* Per-series gaps tooltip */}
        {seriesGaps.length > 0 && (
          <div className="absolute left-0 top-full mt-1 hidden group-hover:block z-50 min-w-48 max-h-48 overflow-auto bg-popover border border-border rounded-lg shadow-lg p-2">
            <div className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground mb-1">Per-Series Gaps</div>
            {seriesGaps.map((s) => (
              <div key={s.id} className="flex justify-between text-xs py-0.5 border-b border-border/30 last:border-0">
                <span className="text-foreground truncate max-w-32">{s.id}</span>
                <span className="text-warning font-semibold ml-2">{s.gaps} / {s.missed}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Init Gap */}
      <div className={cn(
        'flex items-center gap-2 px-2 py-1 rounded-lg border',
        initGap > 0 ? 'bg-warning/10 border-warning/30' : 'bg-muted/20 border-border/30'
      )}>
        <span className="text-muted-foreground text-[10px] uppercase tracking-wider font-semibold">InitGap</span>
        <span className={cn('font-bold', initGap > 0 ? 'text-warning' : 'text-foreground')}>{initGap}</span>
      </div>

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
