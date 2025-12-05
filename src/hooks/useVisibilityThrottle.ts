// Tab visibility throttling hook
// Reduces CPU usage when the chart tab is in the background

import { useEffect, useState, useRef, useCallback } from 'react';

interface UseVisibilityThrottleOptions {
  onVisible?: () => void;
  onHidden?: () => void;
  throttleMs?: number; // Update interval when hidden (default: 1000ms)
}

interface VisibilityState {
  isVisible: boolean;
  wasHidden: boolean;
  hiddenDuration: number;
}

export function useVisibilityThrottle(options: UseVisibilityThrottleOptions = {}) {
  const { onVisible, onHidden, throttleMs = 1000 } = options;
  
  const [state, setState] = useState<VisibilityState>({
    isVisible: !document.hidden,
    wasHidden: false,
    hiddenDuration: 0,
  });
  
  const hiddenAtRef = useRef<number | null>(null);
  const throttleIntervalRef = useRef<number | null>(null);
  
  // Check if we should throttle updates
  const shouldThrottle = useCallback(() => {
    return !state.isVisible;
  }, [state.isVisible]);
  
  // Create throttled callback wrapper
  const createThrottledCallback = useCallback(<T extends (...args: any[]) => any>(
    callback: T,
    minInterval: number = throttleMs
  ): T => {
    let lastCall = 0;
    
    return ((...args: Parameters<T>) => {
      const now = Date.now();
      
      // Always execute if visible
      if (state.isVisible) {
        lastCall = now;
        return callback(...args);
      }
      
      // Throttle when hidden
      if (now - lastCall >= minInterval) {
        lastCall = now;
        return callback(...args);
      }
    }) as T;
  }, [state.isVisible, throttleMs]);
  
  useEffect(() => {
    const handleVisibilityChange = () => {
      const isVisible = !document.hidden;
      
      if (isVisible) {
        // Tab became visible
        const hiddenDuration = hiddenAtRef.current 
          ? Date.now() - hiddenAtRef.current 
          : 0;
        
        setState({
          isVisible: true,
          wasHidden: hiddenAtRef.current !== null,
          hiddenDuration,
        });
        
        hiddenAtRef.current = null;
        
        // Clear throttle interval
        if (throttleIntervalRef.current) {
          clearInterval(throttleIntervalRef.current);
          throttleIntervalRef.current = null;
        }
        
        onVisible?.();
      } else {
        // Tab became hidden
        hiddenAtRef.current = Date.now();
        
        setState(prev => ({
          ...prev,
          isVisible: false,
          wasHidden: false,
          hiddenDuration: 0,
        }));
        
        onHidden?.();
      }
    };
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      
      if (throttleIntervalRef.current) {
        clearInterval(throttleIntervalRef.current);
      }
    };
  }, [onVisible, onHidden]);
  
  return {
    ...state,
    shouldThrottle,
    createThrottledCallback,
  };
}

// RAF-based throttle for render loops
export function useThrottledRAF(
  callback: () => void,
  enabled: boolean = true,
  throttleWhenHidden: boolean = true
) {
  const rafIdRef = useRef<number | null>(null);
  const lastFrameRef = useRef<number>(0);
  const callbackRef = useRef(callback);
  
  const { isVisible } = useVisibilityThrottle();
  
  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);
  
  useEffect(() => {
    if (!enabled) {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }
    
    const targetFps = isVisible || !throttleWhenHidden ? 60 : 5; // 5 FPS when hidden
    const frameInterval = 1000 / targetFps;
    
    const loop = (timestamp: number) => {
      const elapsed = timestamp - lastFrameRef.current;
      
      if (elapsed >= frameInterval) {
        lastFrameRef.current = timestamp - (elapsed % frameInterval);
        callbackRef.current();
      }
      
      rafIdRef.current = requestAnimationFrame(loop);
    };
    
    rafIdRef.current = requestAnimationFrame(loop);
    
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [enabled, isVisible, throttleWhenHidden]);
}
