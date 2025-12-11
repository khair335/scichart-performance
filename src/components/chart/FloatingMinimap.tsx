/**
 * FloatingMinimap Component
 * A draggable, repositionable minimap panel for chart navigation
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { GripVertical, X, Minimize2, Maximize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface FloatingMinimapProps {
  visible: boolean;
  onClose: () => void;
  children?: React.ReactNode;
  className?: string;
  defaultPosition?: { x: number; y: number };
  defaultSize?: { width: number; height: number };
}

export function FloatingMinimap({
  visible,
  onClose,
  children,
  className,
  defaultPosition = { x: 20, y: 20 },
  defaultSize = { width: 300, height: 100 },
}: FloatingMinimapProps) {
  const [position, setPosition] = useState(defaultPosition);
  const [size, setSize] = useState(defaultSize);
  const [isDragging, setIsDragging] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [isMinimized, setIsMinimized] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const dragStartRef = useRef({ x: 0, y: 0, posX: 0, posY: 0 });
  const resizeStartRef = useRef({ x: 0, y: 0, width: 0, height: 0 });

  // Handle drag start
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      posX: position.x,
      posY: position.y,
    };
  }, [position]);

  // Handle resize start
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    resizeStartRef.current = {
      x: e.clientX,
      y: e.clientY,
      width: size.width,
      height: size.height,
    };
  }, [size]);

  // Handle mouse move for dragging and resizing
  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (isDragging) {
        const deltaX = e.clientX - dragStartRef.current.x;
        const deltaY = e.clientY - dragStartRef.current.y;
        
        // Calculate new position with bounds checking
        const newX = Math.max(0, Math.min(window.innerWidth - size.width, dragStartRef.current.posX + deltaX));
        const newY = Math.max(0, Math.min(window.innerHeight - size.height, dragStartRef.current.posY + deltaY));
        
        setPosition({ x: newX, y: newY });
      }
      
      if (isResizing) {
        const deltaX = e.clientX - resizeStartRef.current.x;
        const deltaY = e.clientY - resizeStartRef.current.y;
        
        // Calculate new size with minimum bounds
        const newWidth = Math.max(200, Math.min(600, resizeStartRef.current.width + deltaX));
        const newHeight = Math.max(60, Math.min(300, resizeStartRef.current.height + deltaY));
        
        setSize({ width: newWidth, height: newHeight });
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      setIsResizing(false);
    };

    if (isDragging || isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, isResizing, size.width, size.height]);

  return (
    <div
      ref={panelRef}
      className={cn(
        'fixed z-50 bg-card/95 backdrop-blur-md border border-border rounded-lg shadow-xl',
        'transition-all duration-200',
        isDragging && 'shadow-2xl cursor-grabbing',
        !visible && 'opacity-0 pointer-events-none scale-95',
        className
      )}
      style={{
        left: position.x,
        top: position.y,
        width: size.width,
        height: isMinimized ? 36 : size.height,
      }}
    >
      {/* Header / Drag Handle */}
      <div
        className={cn(
          'flex items-center justify-between px-2 py-1 border-b border-border/50 bg-muted/30 rounded-t-lg',
          'cursor-grab select-none',
          isDragging && 'cursor-grabbing'
        )}
        onMouseDown={handleDragStart}
      >
        <div className="flex items-center gap-1.5">
          <GripVertical className="w-3.5 h-3.5 text-muted-foreground" />
          <span className="text-xs font-medium text-foreground">Minimap</span>
        </div>
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:bg-muted"
            onClick={() => setIsMinimized(!isMinimized)}
            title={isMinimized ? 'Expand' : 'Minimize'}
          >
            {isMinimized ? (
              <Maximize2 className="w-3 h-3 text-muted-foreground" />
            ) : (
              <Minimize2 className="w-3 h-3 text-muted-foreground" />
            )}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 w-6 p-0 hover:bg-destructive/20 hover:text-destructive"
            onClick={onClose}
            title="Close minimap"
          >
            <X className="w-3 h-3" />
          </Button>
        </div>
      </div>

      {/* Content Area */}
      {!isMinimized && (
        <div className="relative w-full h-[calc(100%-36px)] overflow-hidden">
          {children || (
            <div 
              id="floating-minimap-container"
              className="w-full h-full"
            />
          )}
          
          {/* Resize Handle */}
          <div
            className={cn(
              'absolute bottom-0 right-0 w-4 h-4 cursor-se-resize',
              'hover:bg-primary/20 rounded-br-lg transition-colors'
            )}
            onMouseDown={handleResizeStart}
          >
            <svg
              className="w-full h-full text-muted-foreground/50"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M14 14H12V12H14V14ZM14 10H12V8H14V10ZM10 14H8V12H10V14Z" />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
