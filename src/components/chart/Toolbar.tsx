import { Button } from '@/components/ui/button';
import { 
  Play, 
  Pause, 
  ZoomIn, 
  Maximize2,
  Minimize2,
  Map, 
  Sun, 
  Moon,
  FileJson,
  Layers,
  Radio,
  RefreshCw,
  Command,
  Box,
  MoveHorizontal,
  MoveVertical,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

export interface TimeWindowPreset {
  label: string;
  minutes: number; // 0 = entire session
}

interface ToolbarProps {
  isLive: boolean;
  minimapEnabled: boolean;
  theme: 'dark' | 'light';
  onJumpToLive: () => void;
  onToggleLive: () => void;
  onZoomExtents: () => void;
  onToggleFullscreen?: () => void;
  onToggleMinimap: () => void;
  onToggleTheme: () => void;
  onLoadLayout: () => void;
  onOpenSeriesBrowser: () => void;
  onReloadLayout?: () => void;
  onOpenCommandPalette?: () => void;
  currentLayoutName?: string | null;
  layoutError?: string | null;
  seriesCount?: number;
  isFullscreen?: boolean;
  className?: string;
  // Zoom mode
  zoomMode?: 'box' | 'x-only' | 'y-only';
  onZoomModeChange?: (mode: 'box' | 'x-only' | 'y-only') => void;
  // Time window presets
  timeWindowPresets?: TimeWindowPreset[];
  onTimeWindowSelect?: (minutes: number) => void;
}

export function Toolbar({
  isLive,
  minimapEnabled,
  theme,
  onJumpToLive,
  onToggleLive,
  onZoomExtents,
  onToggleFullscreen,
  onToggleMinimap,
  onToggleTheme,
  onLoadLayout,
  onOpenSeriesBrowser,
  currentLayoutName,
  layoutError,
  onReloadLayout,
  seriesCount = 0,
  onOpenCommandPalette,
  isFullscreen = false,
  className,
  zoomMode = 'box',
  onZoomModeChange,
  timeWindowPresets = [],
  onTimeWindowSelect,
}: ToolbarProps) {
  return (
    <div className={cn(
      'hud-panel px-4 py-2.5 flex items-center gap-2',
      className
    )}>
      {/* Live/Pause Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleLive}
        className={cn(
          'h-8 px-3 gap-1.5 text-xs font-medium btn-modern rounded-lg transition-all',
          isLive 
            ? 'text-success hover:text-success hover:bg-success/10 border border-success/30' 
            : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
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
        className="h-8 px-3 gap-1.5 text-xs font-medium btn-modern rounded-lg hover:bg-primary/10 hover:text-primary transition-all"
        title="Jump to latest data (J)"
      >
        <Radio className="w-3.5 h-3.5" />
        <span className="hidden sm:inline">Jump to Live</span>
      </Button>

      <div className="w-px h-6 bg-border/60 mx-1" />

      {/* Zoom Mode Buttons */}
      {onZoomModeChange && (
        <>
          <div className="flex items-center gap-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onZoomModeChange('box')}
              className={cn(
                'h-8 w-8 p-0 rounded-lg btn-modern transition-all',
                zoomMode === 'box'
                  ? 'text-primary bg-primary/10 border border-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              title="Box zoom mode (B)"
            >
              <Box className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onZoomModeChange('x-only')}
              className={cn(
                'h-8 w-8 p-0 rounded-lg btn-modern transition-all',
                zoomMode === 'x-only'
                  ? 'text-primary bg-primary/10 border border-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              title="X-only zoom mode (X)"
            >
              <MoveHorizontal className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onZoomModeChange('y-only')}
              className={cn(
                'h-8 w-8 p-0 rounded-lg btn-modern transition-all',
                zoomMode === 'y-only'
                  ? 'text-primary bg-primary/10 border border-primary/30'
                  : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
              )}
              title="Y-only zoom mode (Y)"
            >
              <MoveVertical className="w-3.5 h-3.5" />
            </Button>
          </div>
          <div className="w-px h-6 bg-border/60 mx-1" />
        </>
      )}

      {/* Time Window Presets */}
      {timeWindowPresets.length > 0 && onTimeWindowSelect && (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 px-3 gap-1.5 text-xs font-medium btn-modern rounded-lg hover:bg-primary/10 hover:text-primary transition-all"
                title="Time window presets"
              >
                <Clock className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Window</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-[140px]">
              {timeWindowPresets.map((preset, index) => (
                <DropdownMenuItem
                  key={index}
                  onClick={() => onTimeWindowSelect(preset.minutes)}
                  className="text-xs"
                >
                  {preset.label}
                </DropdownMenuItem>
              ))}
              {/* Always include Entire Session */}
              <DropdownMenuItem
                onClick={() => onTimeWindowSelect(0)}
                className="text-xs font-semibold"
              >
                Entire Session
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <div className="w-px h-6 bg-border/60 mx-1" />
        </>
      )}

      {/* Zoom Extents */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onZoomExtents}
        className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 btn-modern transition-all"
        title="Fit all data (Z)"
      >
        <ZoomIn className="w-3.5 h-3.5" />
      </Button>

      <div className="w-px h-6 bg-border/60 mx-1" />

      {/* Layout - Left Side */}
      <div className="flex items-center gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Layout</span>
        {/* Layout Name with Reload Icon (when loaded) */}
        {currentLayoutName && (
          <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-muted/30 border border-border/50">
            {onReloadLayout && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onReloadLayout}
                className="h-6 w-6 p-0 hover:bg-primary/20 hover:text-primary rounded transition-all"
                title="Reload layout"
              >
                <RefreshCw className="w-3 h-3" />
              </Button>
            )}
            <span className="text-xs font-semibold text-foreground gradient-text">{currentLayoutName}</span>
          </div>
        )}
        {/* Load Layout Button (when no layout loaded) */}
        {!currentLayoutName && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onLoadLayout}
            className="h-8 px-3 gap-1.5 text-xs font-medium btn-modern rounded-lg hover:bg-primary/10 hover:text-primary transition-all"
            title="Load layout from JSON"
          >
            <FileJson className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Load Layout</span>
          </Button>
        )}
      </div>

      <div className="flex-1" />

      {/* Right side: Series, Minimap, Command, Theme, Fullscreen */}
      <div className="flex items-center gap-1.5">
        {/* Series Browser with Count */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenSeriesBrowser}
          className="h-8 px-3 gap-1.5 text-xs font-medium btn-modern rounded-lg hover:bg-primary/10 hover:text-primary transition-all"
          title="Browse discovered series"
        >
          <Layers className="w-3.5 h-3.5" />
          {seriesCount > 0 && (
            <span className="text-xs font-semibold bg-primary/20 text-primary px-1.5 py-0.5 rounded-full">{seriesCount}</span>
          )}
        </Button>
        
        <div className="w-px h-6 bg-border/60 mx-0.5" />
        
        {/* Toggle Minimap */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleMinimap}
          className={cn(
            'h-8 w-8 p-0 rounded-lg btn-modern transition-all',
            minimapEnabled 
              ? 'text-primary bg-primary/10 border border-primary/30' 
              : 'text-muted-foreground hover:text-foreground hover:bg-muted/50'
          )}
          title="Toggle minimap (M)"
        >
          <Map className="w-3.5 h-3.5" />
        </Button>
        
        {/* Command Palette */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onOpenCommandPalette}
          className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 btn-modern transition-all"
          title="Open command palette (Ctrl/Cmd+K)"
        >
          <Command className="w-3.5 h-3.5" />
        </Button>
        
        {/* Theme Toggle */}
        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleTheme}
          className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 btn-modern transition-all"
          title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme (T)`}
        >
          {theme === 'dark' ? (
            <Sun className="w-3.5 h-3.5" />
          ) : (
            <Moon className="w-3.5 h-3.5" />
          )}
        </Button>
        
        {/* Fullscreen Toggle */}
        {onToggleFullscreen && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onToggleFullscreen}
            className="h-8 w-8 p-0 rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted/50 btn-modern transition-all"
            title={isFullscreen ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
          >
            {isFullscreen ? (
              <Minimize2 className="w-3.5 h-3.5" />
            ) : (
              <Maximize2 className="w-3.5 h-3.5" />
            )}
          </Button>
        )}
      </div>

      {/* Layout Error Indicator */}
      {layoutError && (
        <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-destructive/20 text-destructive border border-destructive/30 backdrop-blur-sm" title={layoutError}>
          <span className="hidden sm:inline">⚠ Layout Error</span>
          <span className="sm:hidden">⚠</span>
        </div>
      )}
    </div>
  );
}
