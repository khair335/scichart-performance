import { useEffect, useRef, useState, useCallback } from 'react';
import { WsFeedClient, MemoryStorage, FeedStatus, RegistryRow, Sample, CursorPolicy } from '@/lib/wsfeed-client';

export type WireFormat = 'auto' | 'text' | 'binary';

interface UseWebSocketFeedOptions {
  url: string;
  onSamples: (samples: Sample[]) => void;
  onSessionComplete?: () => void;
  autoConnect?: boolean;
  cursorPolicy?: CursorPolicy;
  useLocalStorage?: boolean;
  autoReconnect?: boolean;
}

interface FeedState {
  stage: string;
  connected: boolean;
  lastSeq: number;
  historyProgress: number;
  rate: number;
  heartbeatLag: number | null;
  registryCount: number;
  sessionComplete: boolean;
  gaps: number;
  wireFormat: string;
}

export function useWebSocketFeed({ 
  url, 
  onSamples, 
  onSessionComplete, 
  autoConnect = true,
  cursorPolicy = 'auto',
  useLocalStorage = true,
  autoReconnect: autoReconnectOption = true,
}: UseWebSocketFeedOptions) {
  const clientRef = useRef<WsFeedClient | null>(null);
  const onSamplesRef = useRef(onSamples);
  const onSessionCompleteRef = useRef(onSessionComplete);
  
  // Config refs to track latest values without triggering reconnect
  const cursorPolicyRef = useRef(cursorPolicy);
  const useLocalStorageRef = useRef(useLocalStorage);
  const autoReconnectRef = useRef(autoReconnectOption);
  
  const [state, setState] = useState<FeedState>({
    stage: 'idle',
    connected: false,
    lastSeq: 0,
    historyProgress: 0,
    rate: 0,
    heartbeatLag: null,
    registryCount: 0,
    sessionComplete: false,
    gaps: 0,
    wireFormat: '',
  });

  const [registry, setRegistry] = useState<RegistryRow[]>([]);

  // Keep refs up to date
  useEffect(() => {
    onSamplesRef.current = onSamples;
  }, [onSamples]);

  useEffect(() => {
    onSessionCompleteRef.current = onSessionComplete;
  }, [onSessionComplete]);
  
  useEffect(() => {
    cursorPolicyRef.current = cursorPolicy;
  }, [cursorPolicy]);
  
  useEffect(() => {
    useLocalStorageRef.current = useLocalStorage;
  }, [useLocalStorage]);
  
  useEffect(() => {
    autoReconnectRef.current = autoReconnectOption;
    // Update client's auto-reconnect setting if it exists
    if (clientRef.current) {
      clientRef.current.setAutoReconnect(autoReconnectOption);
    }
  }, [autoReconnectOption]);

  const handleStatus = useCallback((status: FeedStatus) => {
    setState(prev => ({
      stage: status.stage,
      connected: status.stage === 'live' || status.stage === 'history' || status.stage === 'delta',
      lastSeq: status.lastSeq,
      historyProgress: status.history.pct,
      rate: status.rate.perSec,
      heartbeatLag: status.heartbeatLagMs,
      registryCount: status.registry.total,
      sessionComplete: prev.sessionComplete,
      gaps: status.gaps?.global?.gaps ?? 0,
      wireFormat: status.wireFormat || '',
    }));
  }, []);

  const handleRegistry = useCallback((rows: RegistryRow[]) => {
    console.log(`[useWebSocketFeed] 📋 Registry updated: ${rows.length} series`, rows.map(r => r.id).slice(0, 5));
    setRegistry(rows);
  }, []);

  const handleEvent = useCallback((evt: { type: string; [key: string]: unknown }) => {
    if (evt.type === 'error') {
      console.error('[WebSocket Error]', evt);
    }
    
    // Handle session completion (test_done event from server)
    if (evt.type === 'test_done') {
      console.log('[WebSocket] ✅ Session complete - server finished sending data, pausing feed');
      setState(prev => ({ ...prev, sessionComplete: true, stage: 'complete', connected: false }));
      onSessionCompleteRef.current?.();
      
      // CRITICAL: Disable auto-reconnect to prevent reloading history
      if (clientRef.current) {
        clientRef.current.setAutoReconnect(false);
      }
    }
  }, []);

  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close();
    }

    // Reset session complete state on new connection
    setState(prev => ({ ...prev, sessionComplete: false, stage: 'connecting' }));

    // Use localStorage or MemoryStorage based on config
    const storage = useLocalStorageRef.current && typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : new MemoryStorage();

    const client = new WsFeedClient({
      url,
      storage: storage,
      cursorPolicy: cursorPolicyRef.current,
      autoReconnect: autoReconnectRef.current,
      autoReconnectInitialDelayMs: 500,
      autoReconnectMaxDelayMs: 5000,
      onSamples: (samples) => {
        onSamplesRef.current(samples);
      },
      onStatus: handleStatus,
      onRegistry: handleRegistry,
      onEvent: (evt) => {
        handleEvent(evt);
        
        // Handle server restart detection
        if (evt.type === 'init_begin') {
          const minSeq = evt.min_seq as number;
          const wmSeq = evt.wm_seq as number;
          const lastSeq = client.getLastSeq();
          
          if (lastSeq > 0 && (minSeq < lastSeq || wmSeq < lastSeq)) {
            console.log(`[WebSocket] Server restart detected: minSeq=${minSeq}, wmSeq=${wmSeq}, lastSeq=${lastSeq}, resetting cursor`);
            client.resetCursor();
          }
        }
        
        if (evt.type === 'reconnect_scheduled') {
          console.log('[WebSocket] Reconnect scheduled:', evt);
        }
        
        if (evt.type === 'decode_error') {
          console.warn('[WebSocket] Decode error:', evt);
        }
      },
    });

    client.connect();
    clientRef.current = client;
  }, [url, handleStatus, handleRegistry, handleEvent]);

  const disconnect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close();
      setState(prev => ({ ...prev, stage: 'closed', connected: false }));
    }
  }, []);
  
  const resetCursor = useCallback((reconnect: boolean = false) => {
    if (clientRef.current) {
      clientRef.current.resetCursor({ persist: true });
      if (reconnect) {
        clientRef.current.close();
        connect();
      }
    }
  }, [connect]);
  
  const setAutoReconnect = useCallback((enabled: boolean) => {
    autoReconnectRef.current = enabled;
    if (clientRef.current) {
      clientRef.current.setAutoReconnect(enabled);
    }
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      if (clientRef.current) {
        clientRef.current.close();
        clientRef.current = null;
      }
    };
  }, [autoConnect, connect]);

  return {
    state,
    registry,
    connect,
    disconnect,
    resetCursor,
    setAutoReconnect,
  };
}
