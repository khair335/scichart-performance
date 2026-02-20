import { useState } from 'react';
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface ConnectionControlsProps {
  wsUrl: string;
  onWsUrlChange?: (url: string) => void;
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
  onWsUrlChange,
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
  const [urlDraft, setUrlDraft] = useState(wsUrl);

  const isConnected = stage === 'live' || stage === 'history' || stage === 'delta' || stage === 'complete';
  const isConnecting = stage === 'connecting';

  const getStatusColor = () => {
    switch (stage) {
      case 'live':
      case 'complete': return 'text-success';
      case 'history':
      case 'delta': return 'text-warning';
      case 'connecting': return 'text-info';
      default: return 'text-destructive';
    }
  };

  const getStatusDotColor = () => {
    switch (stage) {
      case 'live':
      case 'complete': return 'bg-success';
      case 'history':
      case 'delta': return 'bg-warning';
      case 'connecting': return 'bg-info animate-pulse';
      default: return 'bg-destructive';
    }
  };

  const handleUrlKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      onWsUrlChange?.(urlDraft);
    }
  };

  return (
    <div className={cn(
      'hud-panel px-3 py-2 flex items-center gap-3 text-xs border-b border-border shrink-0 flex-wrap',
      className
    )}>
      {/* WS URL */}
      <div className="flex flex-col gap-0.5 min-w-[200px]">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">WebSocket URL</span>
        <Input
          value={urlDraft}
          onChange={e => setUrlDraft(e.target.value)}
          onBlur={() => onWsUrlChange?.(urlDraft)}
          onKeyDown={handleUrlKeyDown}
          className="h-7 text-xs font-mono bg-muted/20 border-border/50 rounded px-2 w-52"
          spellCheck={false}
        />
      </div>

      {/* Cursor Policy */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Cursor Policy</span>
        <div className="h-7 flex items-center px-2 rounded border border-border/40 bg-muted/20 text-xs font-mono text-foreground whitespace-nowrap">
          from_start (always seq=1)
        </div>
      </div>

      {/* Actions */}
      <div className="flex flex-col gap-0.5">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">Actions</span>
        <div className="flex items-center gap-1.5">
          {/* Connect */}
          {!isConnected && !isConnecting && onConnect && (
            <Button
              size="sm"
              onClick={onConnect}
              className="h-7 px-3 text-xs rounded"
            >
              Connect
            </Button>
          )}
          {isConnecting && (
            <Button size="sm" disabled className="h-7 px-3 text-xs rounded">
              <Loader2 className="w-3 h-3 animate-spin mr-1" />
              Connecting…
            </Button>
          )}

          {/* Disconnect */}
          {onDisconnect && (
            <Button
              variant="outline"
              size="sm"
              onClick={onDisconnect}
              className="h-7 px-3 text-xs rounded"
            >
              Disconnect
            </Button>
          )}

          {/* Reset cursor */}
          {onResetCursor && (
            <Button
              variant="outline"
              size="sm"
              onClick={onResetCursor}
              className="h-7 px-3 text-xs rounded"
            >
              Reset cursor
            </Button>
          )}
        </div>
      </div>

      {/* Status badges */}
      <div className="flex items-end gap-2 ml-auto flex-wrap">
        {/* Connected status */}
        <span className={cn(
          'flex items-center gap-1.5 px-2 py-1 rounded border text-xs font-mono',
          isConnected ? 'border-success/30 bg-success/10' : isConnecting ? 'border-info/30 bg-info/10' : 'border-destructive/30 bg-destructive/10'
        )}>
          {isConnecting ? (
            <Loader2 className="w-2.5 h-2.5 animate-spin text-info" />
          ) : (
            <span className={cn('w-2 h-2 rounded-full inline-block', getStatusDotColor())} />
          )}
          <span className={cn('font-semibold', getStatusColor())}>
            {stage || 'idle'}
          </span>
        </span>

        {/* lastSeq */}
        <span className="px-2 py-1 rounded border border-border/30 bg-muted/20 text-xs font-mono text-foreground">
          lastSeq: <span className="font-semibold">{lastSeq.toLocaleString()}</span>
        </span>

        {/* wire format */}
        {wireFormat && (
          <span className="px-2 py-1 rounded border border-border/30 bg-muted/20 text-xs font-mono text-foreground">
            wire: <span className="font-semibold">{wireFormat}</span>
          </span>
        )}

        {/* Rate */}
        <span className="px-2 py-1 rounded border border-border/30 bg-muted/20 text-xs font-mono text-foreground">
          {rate.toFixed(0)}<span className="text-muted-foreground">/s</span>
        </span>

        {/* Lag */}
        {heartbeatLag !== null && (
          <span className={cn(
            'px-2 py-1 rounded border text-xs font-mono',
            heartbeatLag > 1000
              ? 'border-warning/30 bg-warning/10 text-warning'
              : 'border-border/30 bg-muted/20 text-foreground'
          )}>
            lag: <span className="font-semibold">{heartbeatLag}ms</span>
          </span>
        )}

        {/* Gaps */}
        {gaps > 0 && (
          <span className="px-2 py-1 rounded border border-warning/30 bg-warning/10 text-warning text-xs font-mono">
            gaps: <span className="font-semibold">{gaps}</span>
          </span>
        )}

        {/* History progress */}
        {(stage === 'history' || stage === 'delta') && (
          <span className="px-2 py-1 rounded border border-info/30 bg-info/10 text-info text-xs font-mono">
            history: <span className="font-semibold">{historyProgress}%</span>
          </span>
        )}
      </div>
    </div>
  );
}
