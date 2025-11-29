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
    <div className={cn('hud-panel px-3 py-2 flex items-center gap-4 mono-data text-xs', className)}>
      {/* Status */}
      {getStatusPill()}

      {/* Data Clock */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Clock:</span>
        <span className="text-primary font-medium">{formatDataClock(dataClockMs)}</span>
      </div>

      {/* FPS */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">FPS:</span>
        <span className={cn('font-medium', getFpsColor())}>{fps}</span>
      </div>

      {/* Rate */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Rate:</span>
        <span className="text-foreground">{rate.toFixed(0)}/s</span>
      </div>

      {/* Heartbeat Lag */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Lag:</span>
        <span className={cn(
          heartbeatLag !== null && heartbeatLag > 1000 ? 'text-warning' : 'text-foreground'
        )}>
          {heartbeatLag !== null ? `${heartbeatLag}ms` : '—'}
        </span>
      </div>

      {/* Tick Count */}
      <div className="flex items-center gap-1.5">
        <span className="text-muted-foreground">Ticks:</span>
        <span className="text-foreground">{tickCount.toLocaleString()}</span>
      </div>

      {/* Live/Paused indicator */}
      <div className="ml-auto">
        {isLive ? (
          <span className="text-success text-xs">● AUTO-SCROLL</span>
        ) : (
          <span className="text-muted-foreground text-xs">○ PAUSED</span>
        )}
      </div>
    </div>
  );
}
