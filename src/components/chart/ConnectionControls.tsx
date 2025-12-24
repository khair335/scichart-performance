import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import { Wifi, WifiOff, RotateCcw } from 'lucide-react';

export type CursorPolicy = 'auto' | 'resume' | 'from_start';
export type WireFormat = 'auto' | 'text' | 'binary';

interface ConnectionControlsProps {
  wsUrl: string;
  onWsUrlChange: (url: string) => void;
  cursorPolicy: CursorPolicy;
  onCursorPolicyChange: (policy: CursorPolicy) => void;
  wireFormat?: WireFormat; // Kept for backward compat but not used
  onWireFormatChange?: (format: WireFormat) => void; // Not used - server decides
  autoReconnect: boolean;
  onAutoReconnectChange: (enabled: boolean) => void;
  useLocalStorage: boolean;
  onUseLocalStorageChange: (enabled: boolean) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onResetCursor: () => void;
  onClearLog?: () => void;
  isConnected: boolean;
  isConnecting: boolean;
  // Status values
  stage: string;
  lastSeq: number;
  heartbeatLag: number | null;
  rate: number;
  gaps: number;
  wireFormatActive?: string; // Actual wire format from server
  className?: string;
  visible?: boolean;
}

export function ConnectionControls({
  wsUrl,
  onWsUrlChange,
  cursorPolicy,
  onCursorPolicyChange,
  autoReconnect,
  onAutoReconnectChange,
  useLocalStorage,
  onUseLocalStorageChange,
  onConnect,
  onDisconnect,
  onResetCursor,
  isConnected,
  isConnecting,
  stage,
  lastSeq,
  heartbeatLag,
  rate,
  gaps,
  wireFormatActive,
  className,
  visible = true,
}: ConnectionControlsProps) {
  if (!visible) return null;

  const getStatusDotClass = () => {
    if (isConnecting) return 'bg-info animate-pulse';
    if (isConnected) return 'bg-success';
    if (stage === 'error') return 'bg-destructive';
    if (stage === 'closed') return 'bg-warning';
    return 'bg-muted-foreground';
  };

  const getStatusText = () => {
    if (isConnecting) return 'connecting';
    if (isConnected) return 'connected';
    if (stage === 'error') return 'error';
    if (stage === 'closed') return 'closed';
    if (stage === 'complete') return 'complete';
    return 'idle';
  };

  return (
    <div className={cn('hud-panel px-3 py-2', className)}>
      {/* Single row layout matching reference */}
      <div className="flex items-center gap-2 flex-wrap">
        {/* WebSocket URL */}
        <div className="flex flex-col gap-0.5 min-w-[280px] flex-1 max-w-md">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            WebSocket URL
          </label>
          <Input
            value={wsUrl}
            onChange={(e) => onWsUrlChange(e.target.value)}
            placeholder="ws://127.0.0.1:8765"
            className="h-8 text-xs font-mono bg-card border-border/50"
          />
        </div>

        {/* Cursor Policy */}
        <div className="flex flex-col gap-0.5 min-w-[160px]">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Cursor policy
          </label>
          <Select value={cursorPolicy} onValueChange={(v) => onCursorPolicyChange(v as CursorPolicy)}>
            <SelectTrigger className="h-8 text-xs bg-card border-border/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">auto (recommended)</SelectItem>
              <SelectItem value="resume">resume (always lastSeq+1)</SelectItem>
              <SelectItem value="from_start">from_start (always seq=1)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Sample format (read-only - server decides) */}
        <div className="flex flex-col gap-0.5 min-w-[100px]">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Wire format
          </label>
          <div className="h-8 px-3 text-xs bg-card border border-border/50 rounded-md flex items-center font-mono text-muted-foreground">
            {wireFormatActive || 'auto'}
          </div>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-0.5">
          <label className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
            Actions
          </label>
          <div className="flex gap-1.5">
            <Button
              size="sm"
              onClick={onConnect}
              disabled={isConnected || isConnecting}
              className="h-8 px-2.5 text-xs bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
            >
              Connect
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={!isConnected && !isConnecting}
              className="h-8 px-2.5 text-xs font-semibold"
            >
              Disconnect
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onResetCursor}
              className="h-8 px-2.5 text-xs font-semibold"
            >
              Reset cursor
            </Button>
          </div>
        </div>
      </div>

      {/* Status pills row */}
      <div className="flex items-center gap-2 flex-wrap mt-2">
        {/* Connection status pill */}
        <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px] text-muted-foreground">
          <span className={cn('w-2 h-2 rounded-full', getStatusDotClass())} />
          {getStatusText()}
        </span>

        {/* lastSeq */}
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px]">
          <span className="font-mono text-muted-foreground">lastSeq</span>
          <span className="text-muted-foreground">:</span>
          <span className="font-mono text-foreground font-medium">{lastSeq}</span>
        </span>

        {/* stage */}
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px]">
          <span className="font-mono text-muted-foreground">stage</span>
          <span className="text-muted-foreground">:</span>
          <span className="font-mono text-foreground font-medium">{stage || 'idle'}</span>
        </span>

        {/* wire format */}
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px]">
          <span className="font-mono text-muted-foreground">wire</span>
          <span className="text-muted-foreground">:</span>
          <span className="font-mono text-foreground font-medium">{wireFormatActive || '—'}</span>
        </span>

        {/* heartbeatLag */}
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px]">
          <span className="font-mono text-muted-foreground">heartbeatLag</span>
          <span className="text-muted-foreground">:</span>
          <span className="font-mono text-foreground font-medium">
            {heartbeatLag !== null ? `${Math.round(heartbeatLag)}ms` : '—'}
          </span>
        </span>

        {/* rate */}
        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px]">
          <span className="font-mono text-muted-foreground">rate</span>
          <span className="text-muted-foreground">:</span>
          <span className="font-mono text-foreground font-medium">
            {rate > 0 ? `${Math.round(rate)}/s` : '—'}
          </span>
        </span>

        {/* gaps */}
        <span className={cn(
          'inline-flex items-center gap-1 px-2 py-1 rounded-full border text-[11px]',
          gaps > 0 ? 'bg-warning/10 border-warning/30' : 'bg-card border-border/50'
        )}>
          <span className="font-mono text-muted-foreground">gaps</span>
          <span className="text-muted-foreground">:</span>
          <span className={cn('font-mono font-medium', gaps > 0 ? 'text-warning' : 'text-foreground')}>
            {gaps}
          </span>
        </span>

        {/* Checkboxes */}
        <label className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px] cursor-pointer hover:bg-muted/50 transition-colors">
          <Checkbox
            checked={autoReconnect}
            onCheckedChange={(checked) => onAutoReconnectChange(!!checked)}
            className="w-3.5 h-3.5"
          />
          <span className="text-muted-foreground">auto-reconnect</span>
        </label>

        <label className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-card border border-border/50 text-[11px] cursor-pointer hover:bg-muted/50 transition-colors">
          <Checkbox
            checked={useLocalStorage}
            onCheckedChange={(checked) => onUseLocalStorageChange(!!checked)}
            className="w-3.5 h-3.5"
          />
          <span className="text-muted-foreground">use localStorage</span>
        </label>
      </div>
    </div>
  );
}
