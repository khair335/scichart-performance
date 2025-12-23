import { useState, useCallback } from 'react';
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
import { Wifi, WifiOff, RotateCcw, Trash2 } from 'lucide-react';

export type CursorPolicy = 'auto' | 'resume' | 'from_start';
export type WireFormat = 'auto' | 'text' | 'binary';

interface ConnectionControlsProps {
  wsUrl: string;
  onWsUrlChange: (url: string) => void;
  cursorPolicy: CursorPolicy;
  onCursorPolicyChange: (policy: CursorPolicy) => void;
  wireFormat: WireFormat;
  onWireFormatChange: (format: WireFormat) => void;
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
  wireFormatActive?: string;
  className?: string;
  visible?: boolean;
}

export function ConnectionControls({
  wsUrl,
  onWsUrlChange,
  cursorPolicy,
  onCursorPolicyChange,
  wireFormat,
  onWireFormatChange,
  autoReconnect,
  onAutoReconnectChange,
  useLocalStorage,
  onUseLocalStorageChange,
  onConnect,
  onDisconnect,
  onResetCursor,
  onClearLog,
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
    <div className={cn('hud-panel px-4 py-3', className)}>
      {/* Top row: Controls */}
      <div className="grid grid-cols-[1.6fr_0.9fr_0.7fr_1fr] gap-3 items-end mb-3">
        {/* WebSocket URL */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            WebSocket URL
          </label>
          <Input
            value={wsUrl}
            onChange={(e) => onWsUrlChange(e.target.value)}
            placeholder="ws://127.0.0.1:8765"
            className="h-9 text-sm font-mono bg-card border-border/50"
          />
        </div>

        {/* Cursor Policy */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            Cursor policy
          </label>
          <Select value={cursorPolicy} onValueChange={(v) => onCursorPolicyChange(v as CursorPolicy)}>
            <SelectTrigger className="h-9 text-sm bg-card border-border/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">auto (recommended)</SelectItem>
              <SelectItem value="resume">resume (always lastSeq+1)</SelectItem>
              <SelectItem value="from_start">from_start (always seq=1)</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Expected sample format */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            Expected sample format
          </label>
          <Select value={wireFormat} onValueChange={(v) => onWireFormatChange(v as WireFormat)}>
            <SelectTrigger className="h-9 text-sm bg-card border-border/50">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">auto (server decides)</SelectItem>
              <SelectItem value="text">text</SelectItem>
              <SelectItem value="binary">binary</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-1.5">
          <label className="text-[11px] uppercase tracking-wider font-semibold text-muted-foreground">
            Actions
          </label>
          <div className="flex gap-2 flex-wrap">
            <Button
              size="sm"
              onClick={onConnect}
              disabled={isConnected || isConnecting}
              className="h-9 px-3 bg-primary hover:bg-primary/90 text-primary-foreground font-semibold"
            >
              <Wifi className="w-3.5 h-3.5 mr-1.5" />
              Connect
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onDisconnect}
              disabled={!isConnected && !isConnecting}
              className="h-9 px-3 font-semibold"
            >
              <WifiOff className="w-3.5 h-3.5 mr-1.5" />
              Disconnect
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={onResetCursor}
              className="h-9 px-3 font-semibold"
            >
              <RotateCcw className="w-3.5 h-3.5 mr-1.5" />
              Reset cursor
            </Button>
            {onClearLog && (
              <Button
                size="sm"
                variant="outline"
                onClick={onClearLog}
                className="h-9 px-3 font-semibold"
              >
                <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                Clear log
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Bottom row: Status pills */}
      <div className="flex items-center gap-2.5 flex-wrap">
        {/* Connection status pill */}
        <span className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs text-muted-foreground">
          <span className={cn('w-2.5 h-2.5 rounded-full', getStatusDotClass())} />
          {getStatusText()}
        </span>

        {/* lastSeq */}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs">
          <span className="font-mono text-muted-foreground">lastSeq</span>
          <span className="text-foreground font-semibold">:</span>
          <span className="font-mono text-foreground">{lastSeq}</span>
        </span>

        {/* stage */}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs">
          <span className="font-mono text-muted-foreground">stage</span>
          <span className="text-foreground font-semibold">:</span>
          <span className="font-mono text-foreground">{stage || 'idle'}</span>
        </span>

        {/* wire format */}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs">
          <span className="font-mono text-muted-foreground">wire</span>
          <span className="text-foreground font-semibold">:</span>
          <span className="font-mono text-foreground">{wireFormatActive || '—'}</span>
        </span>

        {/* heartbeatLag */}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs">
          <span className="font-mono text-muted-foreground">heartbeatLag</span>
          <span className="text-foreground font-semibold">:</span>
          <span className="font-mono text-foreground">
            {heartbeatLag !== null ? `${heartbeatLag}ms` : '—'}
          </span>
        </span>

        {/* rate */}
        <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs">
          <span className="font-mono text-muted-foreground">rate</span>
          <span className="text-foreground font-semibold">:</span>
          <span className="font-mono text-foreground">
            {rate > 0 ? `${Math.round(rate)}/s` : '—'}
          </span>
        </span>

        {/* gaps */}
        <span className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-full border text-xs',
          gaps > 0 ? 'bg-warning/10 border-warning/30' : 'bg-card border-border/50'
        )}>
          <span className="font-mono text-muted-foreground">gaps</span>
          <span className="text-foreground font-semibold">:</span>
          <span className={cn('font-mono', gaps > 0 ? 'text-warning font-semibold' : 'text-foreground')}>
            {gaps}
          </span>
        </span>

        {/* Checkboxes */}
        <label className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs cursor-pointer hover:bg-muted/50 transition-colors">
          <Checkbox
            checked={autoReconnect}
            onCheckedChange={(checked) => onAutoReconnectChange(!!checked)}
            className="w-4 h-4"
          />
          <span className="text-muted-foreground">auto-reconnect</span>
        </label>

        <label className="inline-flex items-center gap-2 px-2.5 py-1.5 rounded-full bg-card border border-border/50 text-xs cursor-pointer hover:bg-muted/50 transition-colors">
          <Checkbox
            checked={useLocalStorage}
            onCheckedChange={(checked) => onUseLocalStorageChange(!!checked)}
            className="w-4 h-4"
          />
          <span className="text-muted-foreground">use localStorage</span>
        </label>
      </div>
    </div>
  );
}
