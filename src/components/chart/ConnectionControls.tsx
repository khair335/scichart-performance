import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
import { Plug, PlugZap, RefreshCw, Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ConnectionControlsProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Current state
  wsUrl: string;
  stage: string;
  connected: boolean;
  autoReconnect: boolean;
  // Actions
  onConnect: () => void;
  onDisconnect: () => void;
  onResetCursor: () => void;
  onChangeUrl: (url: string) => void;
  onSetAutoReconnect: (enabled: boolean) => void;
}

export function ConnectionControls({
  open,
  onOpenChange,
  wsUrl,
  stage,
  connected,
  autoReconnect,
  onConnect,
  onDisconnect,
  onResetCursor,
  onChangeUrl,
  onSetAutoReconnect,
}: ConnectionControlsProps) {
  const [urlDraft, setUrlDraft] = useState(wsUrl);

  const handleUrlApply = () => {
    if (urlDraft !== wsUrl) {
      onChangeUrl(urlDraft);
    }
  };

  const getStageColor = () => {
    switch (stage) {
      case 'live': return 'bg-success text-success-foreground';
      case 'history':
      case 'delta': return 'bg-warning text-warning-foreground';
      case 'connecting': return 'bg-primary text-primary-foreground';
      case 'complete': return 'bg-primary/80 text-primary-foreground';
      default: return 'bg-destructive text-destructive-foreground';
    }
  };

  const getStageDot = () => {
    switch (stage) {
      case 'live': return 'bg-success glow-success animate-pulse';
      case 'history':
      case 'delta': return 'bg-warning';
      case 'connecting': return 'bg-primary animate-pulse';
      default: return 'bg-destructive';
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 sm:w-96 flex flex-col gap-6 p-6">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <PlugZap className="w-5 h-5 text-primary" />
            Connection Controls
          </SheetTitle>
          <SheetDescription>
            Manage the WebSocket data feed connection.
          </SheetDescription>
        </SheetHeader>

        {/* Status */}
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg bg-muted/40 border border-border/50">
          <span className={cn('w-2.5 h-2.5 rounded-full shrink-0', getStageDot())} />
          <div className="flex-1 min-w-0">
            <p className="text-xs text-muted-foreground uppercase tracking-wider font-semibold">Status</p>
            <p className="text-sm font-semibold text-foreground capitalize">{stage || 'Idle'}</p>
          </div>
          <Badge className={cn('text-xs font-semibold', getStageColor())}>
            {connected ? 'Connected' : 'Disconnected'}
          </Badge>
        </div>

        {/* WS URL */}
        <div className="flex flex-col gap-2">
          <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
            WebSocket URL
          </Label>
          <div className="flex gap-2">
            <Input
              value={urlDraft}
              onChange={e => setUrlDraft(e.target.value)}
              onBlur={handleUrlApply}
              onKeyDown={e => e.key === 'Enter' && handleUrlApply()}
              placeholder="ws://127.0.0.1:8765"
              className="font-mono text-xs h-8 flex-1"
            />
          </div>
          {urlDraft !== wsUrl && (
            <p className="text-xs text-warning">
              Press Enter or click away to apply. A reconnect is needed for the new URL to take effect.
            </p>
          )}
        </div>

        {/* Fixed settings (read-only) */}
        <div className="flex flex-col gap-3 px-3 py-3 rounded-lg bg-muted/20 border border-border/40">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Fixed Settings</p>
          <div className="flex justify-between items-center text-xs">
            <span className="text-muted-foreground">Cursor Policy</span>
            <Badge variant="outline" className="font-mono text-[10px]">from_start</Badge>
          </div>
          <div className="flex justify-between items-center text-xs">
            <span className="text-muted-foreground">Local Storage</span>
            <Badge variant="outline" className="font-mono text-[10px]">disabled</Badge>
          </div>
          <p className="text-[10px] text-muted-foreground/70 leading-relaxed">
            These are locked to ensure data consistency. Every connection always fetches from sequence 1.
          </p>
        </div>

        {/* Auto-reconnect toggle */}
        <div className="flex items-center justify-between px-3 py-2.5 rounded-lg bg-muted/20 border border-border/40">
          <div>
            <Label className="text-sm font-medium cursor-pointer">Auto-Reconnect</Label>
            <p className="text-xs text-muted-foreground mt-0.5">Reconnect automatically on drop</p>
          </div>
          <Switch
            checked={autoReconnect}
            onCheckedChange={onSetAutoReconnect}
          />
        </div>

        {/* Action Buttons */}
        <div className="flex flex-col gap-2 mt-auto">
          {connected ? (
            <Button
              variant="outline"
              className="w-full gap-2 border-destructive/50 text-destructive hover:bg-destructive/10"
              onClick={onDisconnect}
            >
              <WifiOff className="w-4 h-4" />
              Disconnect
            </Button>
          ) : (
            <Button
              className="w-full gap-2"
              onClick={onConnect}
            >
              <Wifi className="w-4 h-4" />
              Connect
            </Button>
          )}

          <Button
            variant="outline"
            className="w-full gap-2"
            onClick={onResetCursor}
          >
            <RefreshCw className="w-4 h-4" />
            Reset Cursor &amp; Reconnect
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
