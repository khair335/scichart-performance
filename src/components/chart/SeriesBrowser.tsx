import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Switch } from '@/components/ui/switch';
import type { RegistryRow } from '@/lib/wsfeed-client';
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
  // Group series by type using namespace-based detection
  const grouped = registry.reduce((acc, row) => {
    const type = getDisplayType(row.id);
    if (!acc[type]) acc[type] = [];
    acc[type].push(row);
    return acc;
  }, {} as Record<string, RegistryRow[]>);

  const typeOrder = ['Tick', 'Indicator', 'OHLC', 'Signal', 'Marker', 'PnL', 'Other'];

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
                    {items.sort((a, b) => a.id.localeCompare(b.id)).map(row => (
                      <div
                        key={row.id}
                        className={cn(
                          'flex items-center gap-2 p-2 rounded-md transition-colors',
                          'hover:bg-sidebar-accent'
                        )}
                      >
                        {getSeriesIcon(row.id)}
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium text-sidebar-foreground truncate">
                            {row.id.split(':').pop()}
                          </div>
                          <div className="text-xs text-muted-foreground mono-data">
                            {formatCount(row.count)} pts • {formatTime(row.lastMs)}
                          </div>
                        </div>
                        <Switch
                          checked={visibleSeries.has(row.id)}
                          onCheckedChange={() => onToggleSeries(row.id)}
                          className="data-[state=checked]:bg-primary"
                        />
                      </div>
                    ))}
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
