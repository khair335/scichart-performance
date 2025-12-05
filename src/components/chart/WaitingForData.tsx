// WaitingForData component - Shows when pane has series defined but no data yet
import { cn } from '@/lib/utils';
import { Loader2 } from 'lucide-react';

interface WaitingForDataProps {
  seriesIds?: string[];
  className?: string;
}

export function WaitingForData({ seriesIds = [], className }: WaitingForDataProps) {
  return (
    <div className={cn(
      'absolute inset-0 flex flex-col items-center justify-center bg-card/95 z-10',
      className
    )}>
      <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mb-3" />
      <span className="text-sm text-muted-foreground">Waiting for data...</span>
      {seriesIds.length > 0 && (
        <span className="text-xs text-muted-foreground/70 mt-1">
          {seriesIds.length} series pending
        </span>
      )}
    </div>
  );
}
