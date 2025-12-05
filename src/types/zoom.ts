// Zoom mode types for chart interaction

export type ZoomMode = 'xy' | 'x' | 'y' | 'box';

export interface ZoomModeConfig {
  id: ZoomMode;
  label: string;
  description: string;
  icon: string; // Icon name from lucide-react
  shortcut: string;
}

export const ZOOM_MODES: ZoomModeConfig[] = [
  {
    id: 'xy',
    label: 'XY Zoom',
    description: 'Zoom both axes with rubber band selection',
    icon: 'Maximize2',
    shortcut: '1',
  },
  {
    id: 'x',
    label: 'X-Only Zoom',
    description: 'Zoom only horizontal axis',
    icon: 'MoveHorizontal',
    shortcut: '2',
  },
  {
    id: 'y',
    label: 'Y-Only Zoom',
    description: 'Zoom only vertical axis',
    icon: 'MoveVertical',
    shortcut: '3',
  },
  {
    id: 'box',
    label: 'Box Zoom',
    description: 'Zoom to exact selection area',
    icon: 'Square',
    shortcut: '4',
  },
];

export const DEFAULT_ZOOM_MODE: ZoomMode = 'xy';
