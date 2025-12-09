import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import type { RegistryRow } from '@/lib/wsfeed-client';
import type { ParsedLayout } from '@/types/plot-layout';
import { cn } from '@/lib/utils';
import { getDisplayType, parseSeriesType } from '@/lib/series-namespace';
import { Activity, BarChart3, TrendingUp, Target, DollarSign } from 'lucide-react';

interface SeriesBrowserProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  registry: RegistryRow[];
  visibleSeries: Set<string>;
  onToggleSeries: (seriesId: string) => void;
  onSelectAll?: () => void;
  onSelectNone?: () => void;
  plotLayout?: ParsedLayout | null;
  onMoveSeries?: (seriesId: string, targetPaneId: string) => void;
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
  plotLayout,
  onMoveSeries,
}: SeriesBrowserProps) {
  // Track selected pane for each series (for move functionality)
  const [selectedPanes, setSelectedPanes] = useState<Map<string, string>>(new Map());
  
  // Group series by type using namespace-based detection
  const grouped = registry.reduce((acc, row) => {
    const type = getDisplayType(row.id);
    if (!acc[type]) acc[type] = [];
    acc[type].push(row);
    return acc;
  }, {} as Record<string, RegistryRow[]>);

  const typeOrder = ['Tick', 'Indicator', 'OHLC', 'Signal', 'Marker', 'PnL', 'Other'];
  
  // Get available panes from layout
  const availablePanes = plotLayout?.layout.panes || [];
  
  // Get current pane for a series
  const getCurrentPane = (seriesId: string): string | null => {
    return plotLayout?.seriesToPaneMap.get(seriesId) || null;
  };
  
  // Handle pane selection change
  const handlePaneSelect = (seriesId: string, paneId: string) => {
    setSelectedPanes(prev => {
      const next = new Map(prev);
      next.set(seriesId, paneId);
      return next;
    });
  };
  
  // Handle move button click
  const handleMove = (seriesId: string) => {
    const targetPaneId = selectedPanes.get(seriesId);
    if (targetPaneId && onMoveSeries) {
      onMoveSeries(seriesId, targetPaneId);
      // Clear selection after move
      setSelectedPanes(prev => {
        const next = new Map(prev);
        next.delete(seriesId);
        return next;
      });
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-[500px] sm:w-[410px] sm:max-w-[600px] bg-sidebar border-sidebar-border">
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
                      const selectedPane = selectedPanes.get(row.id) || currentPane || '';
                      const canMove = plotLayout && availablePanes.length > 0 && onMoveSeries;
                      
                      return (
                        <div key={row.id} className="space-y-1">
                          <div
                            className={cn(
                              'flex items-center gap-2 p-2 rounded-md transition-colors',
                              'hover:bg-sidebar-accent'
                            )}
                          >
                            {getSeriesIcon(row.id)}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-sidebar-foreground truncate" title={row.id}>
                                {row.id}
                              </div>
                              <div className="text-xs text-muted-foreground mono-data">
                                {formatCount(row.count)} pts • {formatTime(row.lastMs)}
                                {currentPane && (
                                  <span className="ml-2 text-primary">{currentPane}</span>
                                )}
                              </div>
                            </div>
                            <Switch
                              checked={visibleSeries.has(row.id)}
                              onCheckedChange={() => onToggleSeries(row.id)}
                              className="data-[state=checked]:bg-primary"
                            />
                          </div>
                          
                          {/* Pane selection and move controls */}
                          {canMove && (
                            <div className="flex items-center gap-2 px-2 pb-2">
                              <Select
                                value={selectedPane}
                                onValueChange={(value) => handlePaneSelect(row.id, value)}
                              >
                                <SelectTrigger className="h-8 text-xs flex-1">
                                  <SelectValue placeholder="Select pane..." />
                                </SelectTrigger>
                                <SelectContent>
                                  {availablePanes.map(pane => (
                                    <SelectItem key={pane.id} value={pane.id}>
                                      {pane.title || pane.id}
                                    </SelectItem>
                                  ))}
                                </SelectContent>
                              </Select>
                              <Button
                                size="sm"
                                variant="default"
                                className="h-8 px-3 text-xs"
                                onClick={() => handleMove(row.id)}
                                disabled={!selectedPane || selectedPane === currentPane}
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
