import { useEffect, useRef, useState, useCallback } from 'react';
import { WsFeedClient, MemoryStorage, FeedStatus, RegistryRow, Sample } from '@/lib/wsfeed-client';

interface UseWebSocketFeedOptions {
  url: string;
  onSamples: (samples: Sample[]) => void;
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
}

export function useWebSocketFeed({ url, onSamples, autoConnect = true }: UseWebSocketFeedOptions) {
  const clientRef = useRef<WsFeedClient | null>(null);
  const onSamplesRef = useRef(onSamples);
  
  const [state, setState] = useState<FeedState>({
    stage: 'idle',
    connected: false,
    lastSeq: 0,
    historyProgress: 0,
    rate: 0,
    heartbeatLag: null,
    registryCount: 0,
  });

  const [registry, setRegistry] = useState<RegistryRow[]>([]);

  // Keep onSamples ref up to date
  useEffect(() => {
    onSamplesRef.current = onSamples;
  }, [onSamples]);

  const handleStatus = useCallback((status: FeedStatus) => {
    setState({
      stage: status.stage,
      connected: status.stage === 'live' || status.stage === 'history' || status.stage === 'delta',
      lastSeq: status.lastSeq,
      historyProgress: status.history.pct,
      rate: status.rate.perSec,
      heartbeatLag: status.heartbeatLagMs,
      registryCount: status.registry.total,
    });
  }, []);

  const handleRegistry = useCallback((rows: RegistryRow[]) => {
    console.log(`[useWebSocketFeed] 📋 Registry updated: ${rows.length} series`);
    setRegistry(rows);
  }, []);

  const connect = useCallback(() => {
    console.log('[useWebSocketFeed] 🔌 Attempting to connect to:', url);
    if (clientRef.current) {
      console.log('[useWebSocketFeed] Closing existing client');
      clientRef.current.close();
    }

    // Use localStorage for data persistence across page refreshes
    // This ensures the UI retrieves all historical + delta + live data even after refresh
    const storage = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : new MemoryStorage();

    console.log('[useWebSocketFeed] Creating new WsFeedClient');
    const client = new WsFeedClient({
      url,
      storage: storage,
      onSamples: (samples) => {
        console.log(`[useWebSocketFeed] 📦 Received ${samples.length} samples`);
        onSamplesRef.current(samples);
      },
      onStatus: handleStatus,
      onRegistry: handleRegistry,
      onEvent: (evt) => {
        console.log('[useWebSocketFeed] 📡 Event:', evt.type, evt);
        if (evt.type === 'error') {
          console.error('[WebSocket Error]', evt);
        }
      },
    });

    console.log('[useWebSocketFeed] ✅ Client created, calling connect()');
    client.connect();
    clientRef.current = client;
    console.log('[useWebSocketFeed] 📊 Client stored in ref');
  }, [url, handleStatus, handleRegistry]);

  const disconnect = useCallback(() => {
    clientRef.current?.close();
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    console.log('[useWebSocketFeed] useEffect triggered, autoConnect:', autoConnect);
    if (autoConnect) {
      console.log('[useWebSocketFeed] AutoConnect is true, calling connect()');
      connect();
    } else {
      console.log('[useWebSocketFeed] AutoConnect is false, skipping connection');
    }

    return () => {
      console.log('[useWebSocketFeed] Cleanup: closing client');
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
