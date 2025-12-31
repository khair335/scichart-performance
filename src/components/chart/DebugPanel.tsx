import { useState, useMemo } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Bug, X, ChevronDown, ChevronUp, Database, Activity, Target, DollarSign } from 'lucide-react';
import type { RegistryRow, Sample } from '@/lib/wsfeed-client';

interface ProtocolStatus {
  requestedFromSeq: number;
  serverMinSeq: number;
  serverWmSeq: number;
  ringCapacity: number | null;
  resumeTruncated: boolean;
  historyProgress: number;
  historyExpected: number;
  historyReceived: number;
}

interface DebugPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry: RegistryRow[];
  notices: Array<{ ts: number; level: string; code: string; text: string; details?: any }>;
  protocolStatus: ProtocolStatus;
  samples: Sample[];
}

export function DebugPanel({
  open,
  onOpenChange,
  registry,
  notices,
  protocolStatus,
  samples,
}: DebugPanelProps) {
  const [activeTab, setActiveTab] = useState('overview');

  // Format timestamp
  const formatTime = (ms: number) => {
    if (!ms || !Number.isFinite(ms)) return '—';
    return new Date(ms).toISOString().replace('T', ' ').slice(0, 23) + 'Z';
  };

  // Parse samples by type
  const { signalsSamples, markersSamples, pnlSamples } = useMemo(() => {
    const signals: Sample[] = [];
    const markers: Sample[] = [];
    const pnl: Sample[] = [];

    for (const sample of samples) {
      const id = sample.series_id.toLowerCase();
      if (id.includes(':signals')) {
        signals.push(sample);
      } else if (id.includes(':markers')) {
        markers.push(sample);
      } else if (id.includes(':pnl')) {
        pnl.push(sample);
      }
    }

    // Sort by sequence descending (most recent first)
    signals.sort((a, b) => b.seq - a.seq);
    markers.sort((a, b) => b.seq - a.seq);
    pnl.sort((a, b) => b.seq - a.seq);

    return { signalsSamples: signals, markersSamples: markers, pnlSamples: pnl };
  }, [samples]);

  // Parse series_id for display
  const parseSeriesId = (seriesId: string) => {
    const parts = seriesId.split(':');
    if (parts.length >= 4 && parts[1] === 'strategy') {
      return { sym: parts[0], strategy: parts[2], type: parts[3] };
    }
    return { sym: parts[0] || '', strategy: '', type: parts[1] || '' };
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[90vw] max-w-[1400px] sm:max-w-[1400px] p-0 bg-background border-l border-border">
        <SheetHeader className="px-6 py-4 border-b border-border bg-card">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Bug className="w-5 h-5 text-primary" />
            </div>
            <div>
              <SheetTitle className="text-lg font-semibold">Debug Panel</SheetTitle>
              <SheetDescription className="text-xs text-muted-foreground">
                Protocol status, series registry, and strategy data
              </SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <Tabs value={activeTab} onValueChange={setActiveTab} className="h-[calc(100vh-80px)]">
          <TabsList className="w-full justify-start rounded-none border-b border-border bg-muted/30 px-4">
            <TabsTrigger value="overview" className="gap-2 data-[state=active]:bg-background">
              <Activity className="w-4 h-4" />
              Overview
            </TabsTrigger>
            <TabsTrigger value="registry" className="gap-2 data-[state=active]:bg-background">
              <Database className="w-4 h-4" />
              Series Registry ({registry.length})
            </TabsTrigger>
            <TabsTrigger value="signals" className="gap-2 data-[state=active]:bg-background">
              <Target className="w-4 h-4" />
              Strategy Intent ({signalsSamples.length})
            </TabsTrigger>
            <TabsTrigger value="markers" className="gap-2 data-[state=active]:bg-background">
              <Target className="w-4 h-4" />
              Strategy Executed ({markersSamples.length})
            </TabsTrigger>
            <TabsTrigger value="pnl" className="gap-2 data-[state=active]:bg-background">
              <DollarSign className="w-4 h-4" />
              PnL ({pnlSamples.length})
            </TabsTrigger>
          </TabsList>

          {/* Overview Tab */}
          <TabsContent value="overview" className="m-0 h-[calc(100%-48px)] overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-6 grid grid-cols-2 gap-6">
                {/* Protocol Status */}
                <div className="bg-card rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4 flex items-center gap-2">
                    <Activity className="w-4 h-4 text-primary" />
                    Protocol Status
                  </h3>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">requested from_seq</span>
                      <span className="text-foreground font-mono">{protocolStatus.requestedFromSeq}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">server min_seq</span>
                      <span className="text-foreground font-mono">{protocolStatus.serverMinSeq}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">server wm_seq</span>
                      <span className="text-foreground font-mono">{protocolStatus.serverWmSeq}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">ring capacity</span>
                      <span className="text-foreground font-mono">{protocolStatus.ringCapacity ?? '—'}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">resume_truncated</span>
                      <span className={cn('font-mono', protocolStatus.resumeTruncated ? 'text-warning' : 'text-foreground')}>
                        {String(protocolStatus.resumeTruncated)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">history progress</span>
                      <span className="text-foreground font-mono">
                        {protocolStatus.historyReceived}/{protocolStatus.historyExpected} ({protocolStatus.historyProgress}%)
                      </span>
                    </div>
                  </div>
                </div>

                {/* Notices */}
                <div className="bg-card rounded-lg border border-border p-4">
                  <h3 className="text-sm font-semibold text-foreground mb-4">Notices</h3>
                  <ScrollArea className="h-[300px]">
                    <div className="space-y-2">
                      {notices.slice().reverse().map((notice, i) => (
                        <div
                          key={i}
                          className={cn(
                            'p-2 rounded text-xs font-mono border-l-2',
                            notice.level === 'error' && 'bg-destructive/10 border-destructive text-destructive',
                            notice.level === 'warn' && 'bg-warning/10 border-warning text-warning',
                            notice.level === 'info' && 'bg-primary/10 border-primary text-primary',
                            notice.level === 'debug' && 'bg-muted border-muted-foreground text-muted-foreground'
                          )}
                        >
                          <div className="flex justify-between items-start gap-2">
                            <span className="font-semibold">{notice.code}</span>
                            <span className="text-[10px] text-muted-foreground">{formatTime(notice.ts)}</span>
                          </div>
                          <div className="mt-1 text-foreground">{notice.text}</div>
                          {notice.details && (
                            <pre className="mt-1 text-[10px] text-muted-foreground overflow-x-auto">
                              {JSON.stringify(notice.details, null, 2)}
                            </pre>
                          )}
                        </div>
                      ))}
                      {notices.length === 0 && (
                        <div className="text-muted-foreground text-sm text-center py-4">No notices yet</div>
                      )}
                    </div>
                  </ScrollArea>
                </div>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Series Registry Tab */}
          <TabsContent value="registry" className="m-0 h-[calc(100%-48px)] overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-4">
                  Auto-discovered from incoming samples. Showing all {registry.length} series.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs font-semibold">series_id</TableHead>
                      <TableHead className="text-xs font-semibold">kind</TableHead>
                      <TableHead className="text-xs font-semibold text-right">count</TableHead>
                      <TableHead className="text-xs font-semibold text-right">first seq</TableHead>
                      <TableHead className="text-xs font-semibold text-right">last seq</TableHead>
                      <TableHead className="text-xs font-semibold text-right">gaps</TableHead>
                      <TableHead className="text-xs font-semibold text-right">missed</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {registry.map((row) => {
                      const kind = row.id.includes(':ticks') ? 'tick' :
                                   row.id.includes(':ohlc') || row.id.includes(':bar') ? 'bar' :
                                   row.id.includes(':sma') || row.id.includes(':ema') ? 'indicator' :
                                   row.id.includes(':pnl') ? 'pnl' :
                                   row.id.includes(':markers') ? 'markers' :
                                   row.id.includes(':signals') ? 'signals' : 'other';
                      return (
                        <TableRow key={row.id} className="hover:bg-muted/50">
                          <TableCell className="font-mono text-xs py-1.5">{row.id}</TableCell>
                          <TableCell className="text-xs py-1.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[10px] font-medium',
                              kind === 'tick' && 'bg-primary/20 text-primary',
                              kind === 'bar' && 'bg-success/20 text-success',
                              kind === 'indicator' && 'bg-warning/20 text-warning',
                              kind === 'pnl' && 'bg-accent/20 text-accent-foreground',
                              kind === 'markers' && 'bg-destructive/20 text-destructive',
                              kind === 'signals' && 'bg-purple-500/20 text-purple-400',
                              kind === 'other' && 'bg-muted text-muted-foreground'
                            )}>
                              {kind}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{row.count.toLocaleString()}</TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{row.firstSeq}</TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{row.lastSeq}</TableCell>
                          <TableCell className={cn('font-mono text-xs text-right py-1.5', row.gaps > 0 && 'text-warning')}>
                            {row.gaps || 0}
                          </TableCell>
                          <TableCell className={cn('font-mono text-xs text-right py-1.5', (row.missed || 0) > 0 && 'text-destructive')}>
                            {row.missed || 0}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Strategy Intent (Signals) Tab */}
          <TabsContent value="signals" className="m-0 h-[calc(100%-48px)] overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-4">
                  Strategy intent signals. Showing all {signalsSamples.length} signals.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs font-semibold">t</TableHead>
                      <TableHead className="text-xs font-semibold">sym</TableHead>
                      <TableHead className="text-xs font-semibold">strategy</TableHead>
                      <TableHead className="text-xs font-semibold">side</TableHead>
                      <TableHead className="text-xs font-semibold text-right">desired_qty</TableHead>
                      <TableHead className="text-xs font-semibold text-right">seq</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {signalsSamples.map((sample, i) => {
                      const parsed = parseSeriesId(sample.series_id);
                      const payload = sample.payload || {};
                      return (
                        <TableRow key={`${sample.seq}-${i}`} className="hover:bg-muted/50">
                          <TableCell className="font-mono text-xs py-1.5">{formatTime(sample.t_ms)}</TableCell>
                          <TableCell className="text-xs py-1.5">{parsed.sym}</TableCell>
                          <TableCell className="text-xs py-1.5">{parsed.strategy}</TableCell>
                          <TableCell className="text-xs py-1.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[10px] font-medium',
                              (payload.side === 'long' || payload.direction === 'long') && 'bg-success/20 text-success',
                              (payload.side === 'short' || payload.direction === 'short') && 'bg-destructive/20 text-destructive'
                            )}>
                              {payload.side || payload.direction || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{payload.desired_qty ?? payload.qty ?? '—'}</TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{sample.seq}</TableCell>
                        </TableRow>
                      );
                    })}
                    {signalsSamples.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          No signal samples received yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* Strategy Executed (Markers) Tab */}
          <TabsContent value="markers" className="m-0 h-[calc(100%-48px)] overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-4">
                  Strategy executed markers. Showing all {markersSamples.length} markers.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs font-semibold">t</TableHead>
                      <TableHead className="text-xs font-semibold">sym</TableHead>
                      <TableHead className="text-xs font-semibold">strategy</TableHead>
                      <TableHead className="text-xs font-semibold">tag</TableHead>
                      <TableHead className="text-xs font-semibold">side</TableHead>
                      <TableHead className="text-xs font-semibold text-right">seq</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {markersSamples.map((sample, i) => {
                      const parsed = parseSeriesId(sample.series_id);
                      const payload = sample.payload || {};
                      return (
                        <TableRow key={`${sample.seq}-${i}`} className="hover:bg-muted/50">
                          <TableCell className="font-mono text-xs py-1.5">{formatTime(sample.t_ms)}</TableCell>
                          <TableCell className="text-xs py-1.5">{parsed.sym}</TableCell>
                          <TableCell className="text-xs py-1.5">{parsed.strategy}</TableCell>
                          <TableCell className="text-xs py-1.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[10px] font-medium',
                              (payload.tag?.includes('entry') || payload.type?.includes('entry')) && 'bg-success/20 text-success',
                              (payload.tag?.includes('exit') || payload.type?.includes('exit')) && 'bg-warning/20 text-warning'
                            )}>
                              {payload.tag || payload.type || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs py-1.5">
                            <span className={cn(
                              'px-1.5 py-0.5 rounded text-[10px] font-medium',
                              (payload.side === 'long' || payload.direction === 'long') && 'bg-success/20 text-success',
                              (payload.side === 'short' || payload.direction === 'short') && 'bg-destructive/20 text-destructive'
                            )}>
                              {payload.side || payload.direction || '—'}
                            </span>
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{sample.seq}</TableCell>
                        </TableRow>
                      );
                    })}
                    {markersSamples.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                          No marker samples received yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </TabsContent>

          {/* PnL Tab */}
          <TabsContent value="pnl" className="m-0 h-[calc(100%-48px)] overflow-hidden">
            <ScrollArea className="h-full">
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-4">
                  PnL samples. Showing all {pnlSamples.length} samples.
                </p>
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead className="text-xs font-semibold">t</TableHead>
                      <TableHead className="text-xs font-semibold">sym</TableHead>
                      <TableHead className="text-xs font-semibold">strategy</TableHead>
                      <TableHead className="text-xs font-semibold text-right">value</TableHead>
                      <TableHead className="text-xs font-semibold text-right">seq</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pnlSamples.map((sample, i) => {
                      const parsed = parseSeriesId(sample.series_id);
                      const value = sample.payload?.v ?? sample.payload?.value ?? sample.payload;
                      return (
                        <TableRow key={`${sample.seq}-${i}`} className="hover:bg-muted/50">
                          <TableCell className="font-mono text-xs py-1.5">{formatTime(sample.t_ms)}</TableCell>
                          <TableCell className="text-xs py-1.5">{parsed.sym}</TableCell>
                          <TableCell className="text-xs py-1.5">{parsed.strategy}</TableCell>
                          <TableCell className={cn(
                            'font-mono text-xs text-right py-1.5',
                            typeof value === 'number' && value > 0 && 'text-success',
                            typeof value === 'number' && value < 0 && 'text-destructive'
                          )}>
                            {typeof value === 'number' ? value.toFixed(4) : JSON.stringify(value)}
                          </TableCell>
                          <TableCell className="font-mono text-xs text-right py-1.5">{sample.seq}</TableCell>
                        </TableRow>
                      );
                    })}
                    {pnlSamples.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                          No PnL samples received yet
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </div>
            </ScrollArea>
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

// Button component to open the debug panel
export function DebugPanelButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={onClick}
      className="gap-2 text-xs"
    >
      <Bug className="w-4 h-4" />
      Debug
    </Button>
  );
}
