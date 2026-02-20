import { cn } from '@/lib/utils';
import { Wifi, WifiOff, Loader2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ConnectionControlsProps {
  wsUrl: string;
  stage: string;
  rate: number;
  lastSeq: number;
  historyProgress: number;
  historyExpected: number;
  historyReceived: number;
  heartbeatLag: number | null;
  registryCount: number;
  gaps: number;
  wireFormat: string;
  requestedFromSeq: number;
  serverMinSeq: number;
  serverWmSeq: number;
  ringCapacity: number | null;
  resumeTruncated: boolean;
  sessionComplete: boolean;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onResetCursor?: () => void;
  onClose?: () => void;
  className?: string;
}

export function ConnectionControls({
  wsUrl,
  stage,
  rate,
  lastSeq,
  historyProgress,
  historyExpected,
  historyReceived,
  heartbeatLag,
  registryCount,
  gaps,
  wireFormat,
  requestedFromSeq,
  serverMinSeq,
  serverWmSeq,
  ringCapacity,
  resumeTruncated,
  sessionComplete,
  onConnect,
  onDisconnect,
  onResetCursor,
  onClose,
  className,
}: ConnectionControlsProps) {
  const isConnected = stage === 'live' || stage === 'history' || stage === 'delta';
  const isConnecting = stage === 'connecting';

  const getStageColor = () => {
    switch (stage) {
      case 'live': return 'text-success';
      case 'history':
      case 'delta': return 'text-warning';
      case 'connecting': return 'text-info';
      case 'complete': return 'text-primary';
      default: return 'text-destructive';
    }
  };

  const getStageIcon = () => {
    if (isConnecting) return <Loader2 className="w-3.5 h-3.5 animate-spin" />;
    if (isConnected || stage === 'complete') return <Wifi className="w-3.5 h-3.5" />;
    return <WifiOff className="w-3.5 h-3.5" />;
  };

  return (
    <div className={cn(
      'hud-panel px-4 py-3 flex flex-col gap-3 text-xs border-b border-border shrink-0',
      className
    )}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('flex items-center gap-1.5 font-semibold', getStageColor())}>
            {getStageIcon()}
            <span className="uppercase tracking-wider">{stage || 'idle'}</span>
          </span>
          <span className="text-muted-foreground font-mono truncate max-w-xs">{wsUrl}</span>
          {wireFormat && (
            <span className="px-1.5 py-0.5 rounded bg-muted/40 text-muted-foreground text-[10px] uppercase tracking-wider">{wireFormat}</span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {/* Connect / Disconnect */}
          {isConnected && onDisconnect && (
            <Button variant="ghost" size="sm" onClick={onDisconnect}
              className="h-7 px-2.5 text-xs text-destructive hover:text-destructive hover:bg-destructive/10 rounded-lg">
              Disconnect
            </Button>
          )}
          {!isConnected && !isConnecting && onConnect && (
            <Button variant="ghost" size="sm" onClick={onConnect}
              className="h-7 px-2.5 text-xs text-success hover:text-success hover:bg-success/10 rounded-lg">
              Connect
            </Button>
          )}
          {onClose && (
            <Button variant="ghost" size="sm" onClick={onClose}
              className="h-7 w-7 p-0 text-muted-foreground hover:text-foreground rounded-lg">
              <X className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-8">
        <Stat label="Seq" value={lastSeq.toLocaleString()} />
        <Stat label="Rate" value={`${rate.toFixed(0)}/s`} />
        <Stat label="Lag" value={heartbeatLag !== null ? `${heartbeatLag}ms` : '—'} warn={heartbeatLag !== null && heartbeatLag > 1000} />
        <Stat label="Series" value={registryCount.toLocaleString()} />
        <Stat label="Gaps" value={gaps.toLocaleString()} warn={gaps > 0} />
        <Stat label="Format" value={wireFormat || '—'} />
        <Stat label="Truncated" value={resumeTruncated ? 'Yes' : 'No'} warn={resumeTruncated} />
        {stage === 'history' || stage === 'delta' ? (
          <Stat label="History" value={`${historyProgress}% (${historyReceived.toLocaleString()}/${historyExpected.toLocaleString()})`} />
        ) : (
          <Stat label="Complete" value={sessionComplete ? 'Yes' : 'No'} />
        )}
      </div>

      {/* Protocol details */}
      <div className="flex items-center gap-4 text-[10px] text-muted-foreground font-mono border-t border-border/40 pt-2">
        <span><span className="text-muted-foreground/60 uppercase mr-1">Policy</span><span className="text-foreground font-semibold">from_start</span></span>
        <span><span className="text-muted-foreground/60 uppercase mr-1">ReqSeq</span>{requestedFromSeq}</span>
        <span><span className="text-muted-foreground/60 uppercase mr-1">MinSeq</span>{serverMinSeq}</span>
        <span><span className="text-muted-foreground/60 uppercase mr-1">WmSeq</span>{serverWmSeq}</span>
        {ringCapacity !== null && <span><span className="text-muted-foreground/60 uppercase mr-1">Ring</span>{ringCapacity.toLocaleString()}</span>}
        <span className="ml-auto text-muted-foreground/40 italic">cursor policy is fixed — always starts from seq 1</span>
      </div>
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 px-2 py-1.5 rounded-lg bg-muted/20 border border-border/30">
      <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">{label}</span>
      <span className={cn('font-semibold text-xs truncate', warn ? 'text-warning' : 'text-foreground')}>{value}</span>
    </div>
  );
}
