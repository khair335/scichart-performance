import { Button } from '@/components/ui/button';
import { 
  Play, 
  Pause, 
  ZoomIn, 
  Maximize2, 
  Map, 
  Sun, 
  Moon,
  FileJson,
  Layers,
  Radio,
} from 'lucide-react';
import { cn } from '@/lib/utils';

interface ToolbarProps {
  isLive: boolean;
  minimapEnabled: boolean;
  theme: 'dark' | 'light';
  onJumpToLive: () => void;
  onToggleLive: () => void;
  onZoomExtents: () => void;
  onToggleMinimap: () => void;
  onToggleTheme: () => void;
  onLoadLayout: () => void;
  onOpenSeriesBrowser: () => void;
  className?: string;
}

export function Toolbar({
  isLive,
  minimapEnabled,
  theme,
  onJumpToLive,
  onToggleLive,
  onZoomExtents,
  onToggleMinimap,
  onToggleTheme,
  onLoadLayout,
  onOpenSeriesBrowser,
  className,
}: ToolbarProps) {
  return (
    <div className={cn(
      'hud-panel px-2 py-1.5 flex items-center gap-1',
      className
    )}>
      {/* Live/Pause Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleLive}
        className={cn(
          'h-7 px-2 gap-1.5 text-xs',
          isLive ? 'text-success hover:text-success' : 'text-muted-foreground'
        )}
        title={isLive ? 'Pause auto-scroll' : 'Resume auto-scroll'}
      >
        {isLive ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        <span className="hidden sm:inline">{isLive ? 'Pause' : 'Live'}</span>
      </Button>

      {/* Jump to Live */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onJumpToLive}
        className="h-7 px-2 gap-1.5 text-xs"
        title="Jump to latest data"
      >
        <Radio className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Jump to Live</span>
      </Button>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Zoom Extents */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onZoomExtents}
        className="h-7 px-2 gap-1.5 text-xs"
        title="Zoom to full extent"
      >
        <Maximize2 className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Fit</span>
      </Button>

      {/* Toggle Minimap */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleMinimap}
        className={cn(
          'h-7 px-2 gap-1.5 text-xs',
          minimapEnabled ? 'text-primary' : 'text-muted-foreground'
        )}
        title="Toggle overview minimap"
      >
        <Map className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Minimap</span>
      </Button>

      <div className="w-px h-5 bg-border mx-1" />

      {/* Series Browser */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onOpenSeriesBrowser}
        className="h-7 px-2 gap-1.5 text-xs"
        title="Browse discovered series"
      >
        <Layers className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Series</span>
      </Button>

      {/* Load Layout */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onLoadLayout}
        className="h-7 px-2 gap-1.5 text-xs"
        title="Load layout from JSON"
      >
        <FileJson className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Layout</span>
      </Button>

      <div className="flex-1" />

      {/* Theme Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleTheme}
        className="h-7 w-7 p-0"
        title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
      >
        {theme === 'dark' ? (
          <Sun className="w-3.5 h-3.5" />
        ) : (
          <Moon className="w-3.5 h-3.5" />
        )}
      </Button>
    </div>
  );
}
