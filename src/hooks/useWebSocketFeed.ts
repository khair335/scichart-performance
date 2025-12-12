import { useEffect, useRef, useState, useCallback } from 'react';
import { WsFeedClient, MemoryStorage, FeedStatus, RegistryRow, Sample } from '@/lib/wsfeed-client';

interface UseWebSocketFeedOptions {
  url: string;
  onSamples: (samples: Sample[]) => void;
  onSessionComplete?: () => void;
  autoConnect?: boolean;
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
}

export function useWebSocketFeed({ url, onSamples, onSessionComplete, autoConnect = true }: UseWebSocketFeedOptions) {
  const clientRef = useRef<WsFeedClient | null>(null);
  const onSamplesRef = useRef(onSamples);
  const onSessionCompleteRef = useRef(onSessionComplete);
  
  const [state, setState] = useState<FeedState>({
    stage: 'idle',
    connected: false,
    lastSeq: 0,
    historyProgress: 0,
    rate: 0,
    heartbeatLag: null,
    registryCount: 0,
    sessionComplete: false,
  });

  const [registry, setRegistry] = useState<RegistryRow[]>([]);

  // Keep refs up to date
  useEffect(() => {
    onSamplesRef.current = onSamples;
  }, [onSamples]);

  useEffect(() => {
    onSessionCompleteRef.current = onSessionComplete;
  }, [onSessionComplete]);

  const handleStatus = useCallback((status: FeedStatus) => {
    setState(prev => ({
      stage: status.stage,
      connected: status.stage === 'live' || status.stage === 'history' || status.stage === 'delta',
      lastSeq: status.lastSeq,
      historyProgress: status.history.pct,
      rate: status.rate.perSec,
      heartbeatLag: status.heartbeatLagMs,
      registryCount: status.registry.total,
      sessionComplete: prev.sessionComplete, // Preserve session complete state
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
      console.log('[WebSocket] Session complete - server finished sending data');
      setState(prev => ({ ...prev, sessionComplete: true, stage: 'complete' }));
      onSessionCompleteRef.current?.();
    }
  }, []);

  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close();
    }

    // Reset session complete state on new connection
    setState(prev => ({ ...prev, sessionComplete: false }));

    // Use localStorage for data persistence across page refreshes
    const storage = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : new MemoryStorage();

    const client = new WsFeedClient({
      url,
      storage: storage,
      onSamples: (samples) => {
        onSamplesRef.current(samples);
      },
      onStatus: handleStatus,
      onRegistry: handleRegistry,
      onEvent: handleEvent,
    });

    client.connect();
    clientRef.current = client;
  }, [url, handleStatus, handleRegistry, handleEvent]);

  const disconnect = useCallback(() => {
    clientRef.current?.close();
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
  };
}
