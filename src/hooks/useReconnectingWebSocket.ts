// WebSocket reconnection hook with exponential backoff
import { useEffect, useRef, useState, useCallback } from 'react';

interface ReconnectOptions {
  url: string;
  onOpen?: (ws: WebSocket) => void;
  onMessage?: (event: MessageEvent) => void;
  onClose?: (event: CloseEvent) => void;
  onError?: (event: Event) => void;
  maxRetries?: number;
  initialDelay?: number; // ms
  maxDelay?: number; // ms
  backoffMultiplier?: number;
  autoConnect?: boolean;
}

interface ReconnectState {
  isConnected: boolean;
  isConnecting: boolean;
  retryCount: number;
  nextRetryIn: number | null; // ms until next retry
  lastError: string | null;
}

export function useReconnectingWebSocket(options: ReconnectOptions) {
  const {
    url,
    onOpen,
    onMessage,
    onClose,
    onError,
    maxRetries = 10,
    initialDelay = 1000,
    maxDelay = 30000,
    backoffMultiplier = 2,
    autoConnect = true,
  } = options;
  
  const wsRef = useRef<WebSocket | null>(null);
  const retryTimeoutRef = useRef<number | null>(null);
  const retryCountRef = useRef(0);
  const shouldReconnectRef = useRef(true);
  const countdownIntervalRef = useRef<number | null>(null);
  
  const [state, setState] = useState<ReconnectState>({
    isConnected: false,
    isConnecting: false,
    retryCount: 0,
    nextRetryIn: null,
    lastError: null,
  });
  
  // Calculate delay with exponential backoff and jitter
  const calculateDelay = useCallback((retryCount: number): number => {
    const exponentialDelay = initialDelay * Math.pow(backoffMultiplier, retryCount);
    const cappedDelay = Math.min(exponentialDelay, maxDelay);
    // Add jitter (±20%)
    const jitter = cappedDelay * 0.2 * (Math.random() * 2 - 1);
    return Math.round(cappedDelay + jitter);
  }, [initialDelay, maxDelay, backoffMultiplier]);
  
  // Clear timers
  const clearTimers = useCallback(() => {
    if (retryTimeoutRef.current) {
      clearTimeout(retryTimeoutRef.current);
      retryTimeoutRef.current = null;
    }
    if (countdownIntervalRef.current) {
      clearInterval(countdownIntervalRef.current);
      countdownIntervalRef.current = null;
    }
  }, []);
  
  // Connect to WebSocket
  const connect = useCallback(() => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      return;
    }
    
    clearTimers();
    shouldReconnectRef.current = true;
    
    setState(prev => ({
      ...prev,
      isConnecting: true,
      nextRetryIn: null,
    }));
    
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      
      ws.onopen = (event) => {
        retryCountRef.current = 0;
        setState({
          isConnected: true,
          isConnecting: false,
          retryCount: 0,
          nextRetryIn: null,
          lastError: null,
        });
        onOpen?.(ws);
      };
      
      ws.onmessage = (event) => {
        onMessage?.(event);
      };
      
      ws.onerror = (event) => {
        setState(prev => ({
          ...prev,
          lastError: 'WebSocket error occurred',
        }));
        onError?.(event);
      };
      
      ws.onclose = (event) => {
        setState(prev => ({
          ...prev,
          isConnected: false,
          isConnecting: false,
        }));
        
        onClose?.(event);
        
        // Schedule reconnect if appropriate
        if (shouldReconnectRef.current && retryCountRef.current < maxRetries) {
          const delay = calculateDelay(retryCountRef.current);
          retryCountRef.current++;
          
          setState(prev => ({
            ...prev,
            retryCount: retryCountRef.current,
            nextRetryIn: delay,
            lastError: event.wasClean ? null : `Connection closed (code: ${event.code})`,
          }));
          
          // Start countdown
          const startTime = Date.now();
          countdownIntervalRef.current = window.setInterval(() => {
            const remaining = Math.max(0, delay - (Date.now() - startTime));
            setState(prev => ({ ...prev, nextRetryIn: remaining }));
            
            if (remaining <= 0) {
              clearInterval(countdownIntervalRef.current!);
              countdownIntervalRef.current = null;
            }
          }, 100);
          
          retryTimeoutRef.current = window.setTimeout(() => {
            connect();
          }, delay);
        }
      };
    } catch (err) {
      setState(prev => ({
        ...prev,
        isConnecting: false,
        lastError: err instanceof Error ? err.message : 'Failed to create WebSocket',
      }));
    }
  }, [url, onOpen, onMessage, onClose, onError, maxRetries, calculateDelay, clearTimers]);
  
  // Disconnect and stop reconnecting
  const disconnect = useCallback(() => {
    shouldReconnectRef.current = false;
    clearTimers();
    retryCountRef.current = 0;
    
    if (wsRef.current) {
      wsRef.current.close(1000, 'User disconnect');
      wsRef.current = null;
    }
    
    setState({
      isConnected: false,
      isConnecting: false,
      retryCount: 0,
      nextRetryIn: null,
      lastError: null,
    });
  }, [clearTimers]);
  
  // Reset and reconnect
  const reconnect = useCallback(() => {
    disconnect();
    setTimeout(connect, 100);
  }, [disconnect, connect]);
  
  // Send message
  const send = useCallback((data: string | ArrayBuffer | Blob) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(data);
      return true;
    }
    return false;
  }, []);
  
  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    
    return () => {
      shouldReconnectRef.current = false;
      clearTimers();
      wsRef.current?.close(1000, 'Component unmount');
    };
  }, [autoConnect, connect, clearTimers]);
  
  return {
    ...state,
    connect,
    disconnect,
    reconnect,
    send,
    ws: wsRef.current,
  };
}
