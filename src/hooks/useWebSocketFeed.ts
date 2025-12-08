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
    setRegistry(rows);
  }, []);

  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close();
    }

    // Use localStorage for data persistence across page refreshes
    // This ensures the UI retrieves all historical + delta + live data even after refresh
    const storage = typeof window !== 'undefined' && window.localStorage
      ? window.localStorage
      : new MemoryStorage();

    const client = new WsFeedClient({
      url,
      storage: storage,
      onSamples: (samples) => onSamplesRef.current(samples),
      onStatus: handleStatus,
      onRegistry: handleRegistry,
      onEvent: (evt) => {
        if (evt.type === 'error') {
          console.error('[WebSocket Error]', evt);
        }
      },
    });

    clientRef.current = client;
    client.connect();
  }, [url, handleStatus, handleRegistry]);

  const disconnect = useCallback(() => {
    clientRef.current?.close();
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }

    return () => {
      clientRef.current?.close();
    };
  }, [autoConnect, connect]);

  return {
    state,
    registry,
    connect,
    disconnect,
  };
}
