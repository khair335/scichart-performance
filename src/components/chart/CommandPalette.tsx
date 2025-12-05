import { useEffect, useState, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
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
} from 'lucide-react';

interface Command {
  id: string;
  label: string;
  description: string;
  icon: React.ReactNode;
  action: () => void;
  keywords: string[];
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onJumpToLive: () => void;
  onToggleLive: () => void;
  onZoomExtents: () => void;
  onToggleMinimap: () => void;
  onToggleTheme: () => void;
  onLoadLayout: () => void;
  onOpenSeriesBrowser: () => void;
  isLive: boolean;
  minimapEnabled: boolean;
  theme: 'dark' | 'light';
}

export function CommandPalette({
  open,
  onOpenChange,
  onJumpToLive,
  onToggleLive,
  onZoomExtents,
  onToggleMinimap,
  onToggleTheme,
  onLoadLayout,
  onOpenSeriesBrowser,
  isLive,
  minimapEnabled,
  theme,
}: CommandPaletteProps) {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const commands: Command[] = [
    {
      id: 'jump-to-live',
      label: 'Jump to Live',
      description: 'Jump to the latest data point',
      icon: <Play className="w-4 h-4" />,
      action: () => {
        onJumpToLive();
        onOpenChange(false);
      },
      keywords: ['jump', 'live', 'latest', 'now'],
    },
    {
      id: 'toggle-live',
      label: isLive ? 'Pause' : 'Resume',
      description: isLive ? 'Pause auto-scrolling' : 'Resume auto-scrolling',
      icon: isLive ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />,
      action: () => {
        onToggleLive();
        onOpenChange(false);
      },
      keywords: ['pause', 'play', 'resume', 'live', 'stop'],
    },
    {
      id: 'zoom-extents',
      label: 'Fit to View',
      description: 'Zoom to fit all data',
      icon: <Maximize2 className="w-4 h-4" />,
      action: () => {
        onZoomExtents();
        onOpenChange(false);
      },
      keywords: ['fit', 'zoom', 'extents', 'all', 'view'],
    },
    {
      id: 'toggle-minimap',
      label: minimapEnabled ? 'Hide Minimap' : 'Show Minimap',
      description: minimapEnabled ? 'Hide the overview chart' : 'Show the overview chart',
      icon: <Map className="w-4 h-4" />,
      action: () => {
        onToggleMinimap();
        onOpenChange(false);
      },
      keywords: ['minimap', 'overview', 'navigator'],
    },
    {
      id: 'toggle-theme',
      label: theme === 'dark' ? 'Light Theme' : 'Dark Theme',
      description: `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`,
      icon: theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />,
      action: () => {
        onToggleTheme();
        onOpenChange(false);
      },
      keywords: ['theme', 'dark', 'light', 'mode', 'appearance'],
    },
    {
      id: 'load-layout',
      label: 'Load Layout',
      description: 'Load layout from JSON file',
      icon: <FileJson className="w-4 h-4" />,
      action: () => {
        onLoadLayout();
        onOpenChange(false);
      },
      keywords: ['layout', 'load', 'json', 'config', 'file'],
    },
    {
      id: 'open-series',
      label: 'Series Browser',
      description: 'Open the series browser',
      icon: <Layers className="w-4 h-4" />,
      action: () => {
        onOpenSeriesBrowser();
        onOpenChange(false);
      },
      keywords: ['series', 'browse', 'discover', 'list'],
    },
  ];

  const filteredCommands = commands.filter(cmd => {
    if (!search) return true;
    const searchLower = search.toLowerCase();
    return (
      cmd.label.toLowerCase().includes(searchLower) ||
      cmd.description.toLowerCase().includes(searchLower) ||
      cmd.keywords.some(kw => kw.includes(searchLower))
    );
  });

  useEffect(() => {
    if (open) {
      setSearch('');
      setSelectedIndex(0);
    }
  }, [open]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [search]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(i => Math.min(i + 1, filteredCommands.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (filteredCommands[selectedIndex]) {
        filteredCommands[selectedIndex].action();
      }
    }
  }, [filteredCommands, selectedIndex]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[550px] p-0 gap-0">
        <DialogHeader className="px-4 pt-4 pb-3 border-b border-border">
          <DialogTitle className="text-sm font-medium">Command Palette</DialogTitle>
        </DialogHeader>
        
        <div className="px-4 py-3 border-b border-border">
          <Input
            placeholder="Type a command or search..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
            className="h-9"
          />
        </div>

        <ScrollArea className="max-h-[400px]">
          <div className="p-2">
            {filteredCommands.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground text-sm">
                No commands found
              </div>
            ) : (
              filteredCommands.map((cmd, index) => (
                <button
                  key={cmd.id}
                  onClick={cmd.action}
                  className={cn(
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-left transition-colors',
                    index === selectedIndex
                      ? 'bg-accent text-accent-foreground'
                      : 'hover:bg-accent/50'
                  )}
                  onMouseEnter={() => setSelectedIndex(index)}
                >
                  <div className="flex items-center justify-center w-8 h-8 rounded-md bg-muted/50">
                    {cmd.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium">{cmd.label}</div>
                    <div className="text-xs text-muted-foreground truncate">
                      {cmd.description}
                    </div>
                  </div>
                </button>
              ))
            )}
          </div>
        </ScrollArea>

        <div className="px-4 py-2 border-t border-border bg-muted/30">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <kbd className="px-1.5 py-0.5 rounded bg-background border border-border">↑↓</kbd>
            <span>Navigate</span>
            <kbd className="px-1.5 py-0.5 rounded bg-background border border-border">Enter</kbd>
            <span>Select</span>
            <kbd className="px-1.5 py-0.5 rounded bg-background border border-border">Esc</kbd>
            <span>Close</span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

