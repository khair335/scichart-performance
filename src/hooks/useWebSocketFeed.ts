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

export interface FeedState {
  stage: string;
  connected: boolean;
  lastSeq: number;
  historyProgress: number;
  historyExpected: number;
  historyReceived: number;
  rate: number;
  heartbeatLag: number | null;
  registryCount: number;
  sessionComplete: boolean;
  gaps: number;
  wireFormat: string;
  // Protocol status fields
  requestedFromSeq: number;
  serverMinSeq: number;
  serverWmSeq: number;
  ringCapacity: number | null;
  resumeTruncated: boolean;
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

  // During a reset+reconnect, the old socket can still deliver a few late frames.
  // If we accept those, and then replay history from seq=1, we can end up appending
  // older timestamps after newer ones -> visible “bridge” lines.
  const suppressSamplesRef = useRef(false);

  const [state, setState] = useState<FeedState>({
    stage: 'idle',
    connected: false,
    lastSeq: 0,
    historyProgress: 0,
    historyExpected: 0,
    historyReceived: 0,
    rate: 0,
    heartbeatLag: null,
    registryCount: 0,
    sessionComplete: false,
    gaps: 0,
    wireFormat: '',
    requestedFromSeq: 0,
    serverMinSeq: 0,
    serverWmSeq: 0,
    ringCapacity: null,
    resumeTruncated: false,
  });
  
  const [notices, setNotices] = useState<Array<{ ts: number; level: string; code: string; text: string; details?: any }>>([]);
  const MAX_NOTICES = 200;

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
    // Once the *new* connection starts progressing, allow samples again.
    if (suppressSamplesRef.current && (status.stage === 'history' || status.stage === 'delta' || status.stage === 'live')) {
      suppressSamplesRef.current = false;
    }

    setState(prev => ({
      stage: status.stage,
      connected: status.stage === 'live' || status.stage === 'history' || status.stage === 'delta',
      lastSeq: status.lastSeq,
      historyProgress: status.history.pct,
      historyExpected: status.history.expected,
      historyReceived: status.history.received,
      rate: status.rate.perSec,
      heartbeatLag: status.heartbeatLagMs,
      registryCount: status.registry.total,
      sessionComplete: prev.sessionComplete,
      gaps: status.gaps?.global?.gaps ?? 0,
      wireFormat: status.wireFormat || '',
      requestedFromSeq: status.resume?.requestedFromSeq ?? 0,
      serverMinSeq: status.bounds?.minSeq ?? 0,
      serverWmSeq: status.bounds?.wmSeq ?? 0,
      ringCapacity: status.bounds?.ringCapacity ?? null,
      resumeTruncated: status.resume?.truncated ?? false,
    }));
  }, []);

  const handleRegistry = useCallback((rows: RegistryRow[]) => {
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
        if (suppressSamplesRef.current) return;
        onSamplesRef.current(samples);
      },
      onStatus: handleStatus,
      onRegistry: handleRegistry,
      onNotice: (notice) => {
        setNotices(prev => {
          const newNotices = [...prev, {
            ts: notice.ts,
            level: notice.level,
            code: notice.code,
            text: notice.text,
            details: notice.details,
          }];
          // Trim to prevent unbounded growth
          if (newNotices.length > MAX_NOTICES) {
            return newNotices.slice(-MAX_NOTICES);
          }
          return newNotices;
        });
      },
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
    if (!clientRef.current) return;

    // Suppress late frames from the old socket so we don't append "new" data and then replay history.
    suppressSamplesRef.current = true;

    clientRef.current.resetCursor({ persist: true });

    if (reconnect) {
      clientRef.current.close();
      connect();
    } else {
      // No reconnect: allow samples immediately.
      suppressSamplesRef.current = false;
    }
  }, [connect]);
  
  const setAutoReconnect = useCallback((enabled: boolean) => {
    autoReconnectRef.current = enabled;
    if (clientRef.current) {
      clientRef.current.setAutoReconnect(enabled);
    }
  }, []);

  const setCursorPolicy = useCallback((policy: CursorPolicy) => {
    cursorPolicyRef.current = policy;
    if (clientRef.current) {
      clientRef.current.setCursorPolicy(policy);
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

  const clearNotices = useCallback(() => {
    setNotices([]);
  }, []);

  return {
    state,
    registry,
    notices,
    connect,
    disconnect,
    resetCursor,
    setAutoReconnect,
    setCursorPolicy,
    clearNotices,
  };
}
