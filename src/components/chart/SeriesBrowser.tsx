import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { RegistryRow } from '@/lib/wsfeed-client';
import { cn } from '@/lib/utils';
import { getDisplayType, parseSeriesType } from '@/lib/series-namespace';
import { Activity, BarChart3, TrendingUp, Target, DollarSign, MoveRight } from 'lucide-react';
import { LayoutEngine } from '@/lib/layout-engine';

interface SeriesBrowserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry: RegistryRow[];
  visibleSeries: Set<string>;
  onToggleSeries: (seriesId: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
}

function getSeriesIcon(seriesId: string) {
  const info = parseSeriesType(seriesId);
  
  switch (info.type) {
    case 'tick':
      return <Activity className="w-4 h-4 text-primary" />;
    case 'tick-indicator':
    case 'bar-indicator':
      return <TrendingUp className="w-4 h-4 text-accent" />;
    case 'ohlc-bar':
      return <BarChart3 className="w-4 h-4 text-chart-up" />;
    case 'strategy-pnl':
      return <DollarSign className="w-4 h-4 text-success" />;
    case 'strategy-signal':
    case 'strategy-marker':
      return <Target className="w-4 h-4 text-warning" />;
    default:
      return <Activity className="w-4 h-4 text-muted-foreground" />;
  }
}

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toString();
}

function formatTime(ms: number): string {
  if (!ms || !Number.isFinite(ms)) return '--:--:--';
  const d = new Date(ms);
  return d.toISOString().replace('T', ' ').slice(11, 19);
}

export function SeriesBrowser({
  open,
  onOpenChange,
  registry,
  visibleSeries,
  onToggleSeries,
  onSelectAll,
  onSelectNone,
}: SeriesBrowserProps) {
  const [moveSeriesId, setMoveSeriesId] = useState<string | null>(null);
  const [moveToPaneId, setMoveToPaneId] = useState<string>('');
  
  // Get available panes from LayoutEngine
  const state = LayoutEngine.getState();
  const availablePanes = Array.from(state.panes.keys());
  
  // Group series by type using namespace-based detection
  const grouped = registry.reduce((acc, row) => {
    const type = getDisplayType(row.id);
    if (!acc[type]) acc[type] = [];
    acc[type].push(row);
    return acc;
  }, {} as Record<string, RegistryRow[]>);

  const typeOrder = ['Tick', 'Indicator', 'OHLC', 'Signal', 'Marker', 'PnL', 'Other'];

  // Handle move series to different pane
  const handleMoveSeries = (seriesId: string, targetPaneId: string) => {
    if (!targetPaneId) return;
    
    const success = LayoutEngine.moveSeriesToPane(seriesId, targetPaneId);
    if (success) {
      console.log(`[SeriesBrowser] Moved ${seriesId} to pane ${targetPaneId}`);
      setMoveSeriesId(null);
      setMoveToPaneId('');
    } else {
      console.error(`[SeriesBrowser] Failed to move ${seriesId} to pane ${targetPaneId}`);
    }
  };

  // Get current pane for a series
  const getCurrentPane = (seriesId: string): string | null => {
    const pane = LayoutEngine.getPaneForSeries(seriesId);
    return pane?.id ?? null;
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-80 bg-sidebar border-sidebar-border">
        <SheetHeader>
          <SheetTitle className="text-sidebar-foreground">Discovered Series</SheetTitle>
        </SheetHeader>
        
        {/* Select All/None buttons */}
        <div className="flex gap-2 mt-4">
          <button
            onClick={onSelectAll}
            className="flex-1 px-3 py-2 text-xs font-medium bg-primary text-primary-foreground rounded-md hover:bg-primary/90 transition-colors"
          >
            Select All
          </button>
          <button
            onClick={onSelectNone}
            className="flex-1 px-3 py-2 text-xs font-medium bg-muted text-muted-foreground rounded-md hover:bg-muted/80 transition-colors"
          >
            Clear All
          </button>
        </div>
        
        <ScrollArea className="h-[calc(100vh-160px)] mt-4">
          <div className="space-y-4 pr-4">
            {typeOrder.map(type => {
              const items = grouped[type];
              if (!items || items.length === 0) return null;

              return (
                <div key={type}>
                  <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {type} ({items.length})
                  </h4>
                  <div className="space-y-1">
                    {items.sort((a, b) => a.id.localeCompare(b.id)).map(row => {
                      const currentPane = getCurrentPane(row.id);
                      const isMoving = moveSeriesId === row.id;
                      
                      return (
                        <div
                          key={row.id}
                          className={cn(
                            'flex flex-col gap-2 p-2 rounded-md transition-colors',
                            'hover:bg-sidebar-accent',
                            isMoving && 'bg-sidebar-accent'
                          )}
                        >
                          <div className="flex items-center gap-2">
                            {getSeriesIcon(row.id)}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-sidebar-foreground truncate">
                                {row.id.split(':').pop()}
                              </div>
                              <div className="text-xs text-muted-foreground mono-data">
                                {formatCount(row.count)} pts • {formatTime(row.lastMs)}
                                {currentPane && <span className="ml-1 text-primary/70">• {currentPane}</span>}
                              </div>
                            </div>
                            
                            {/* Move button */}
                            {availablePanes.length > 1 && currentPane && (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="h-6 w-6 p-0"
                                onClick={() => setMoveSeriesId(isMoving ? null : row.id)}
                                title="Move to another pane"
                              >
                                <MoveRight className="w-3 h-3" />
                              </Button>
                            )}
                            
                            <Switch
                              checked={visibleSeries.has(row.id)}
                              onCheckedChange={() => onToggleSeries(row.id)}
                              className="data-[state=checked]:bg-primary"
                            />
                          </div>
                          
                          {/* Move pane selector */}
                          {isMoving && (
                            <div className="flex items-center gap-2 pl-6">
                              <Select
                                value={moveToPaneId}
                                onValueChange={setMoveToPaneId}
                              >
                                <SelectTrigger className="h-7 text-xs flex-1">
                                  <SelectValue placeholder="Select pane..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {availablePanes
                                    .filter(id => id !== currentPane)
                                    .map(paneId => (
                                      <SelectItem key={paneId} value={paneId}>
                                        {paneId}
                                      </SelectItem>
                                    ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                className="h-7 text-xs"
                                disabled={!moveToPaneId}
                                onClick={() => handleMoveSeries(row.id, moveToPaneId)}
                              >
                                Move
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}

            {registry.length === 0 && (
              <div className="text-center py-8 text-muted-foreground">
                <Activity className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No series discovered yet</p>
                <p className="text-xs mt-1">Waiting for data...</p>
              </div>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
