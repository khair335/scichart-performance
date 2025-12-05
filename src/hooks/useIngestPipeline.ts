// useIngestPipeline - Connects WebSocket feed to SeriesStore
// Implements the data pipeline: WS → Parse → Buffer → Drain
// Now with reconnection support via useReconnectingWebSocket

import { useEffect, useRef, useCallback, useState } from 'react';
import { WsFeedClient, MemoryStorage, FeedStatus, RegistryRow, Sample } from '@/lib/wsfeed-client';
import { SeriesStore } from '@/lib/series-store';
import { useReconnectingWebSocket } from './useReconnectingWebSocket';
import type { UIConfig } from '@/types/layout';

interface UseIngestPipelineOptions {
  wsUrl: string;
  uiConfig?: UIConfig;
  autoConnect?: boolean;
  onStatusChange?: (status: FeedStatus) => void;
  onRegistryChange?: (registry: RegistryRow[]) => void;
}

interface PipelineStats {
  samplesReceived: number;
  samplesPerSecond: number;
  seriesCount: number;
  totalPoints: number;
  queuedBatches: number;
}

interface UseIngestPipelineReturn {
  stage: string;
  isConnected: boolean;
  stats: PipelineStats;
  registry: RegistryRow[];
  connect: () => void;
  disconnect: () => void;
  status: FeedStatus | null;
  reconnectState: {
    retryCount: number;
    nextRetryIn: number | null;
    lastError: string | null;
  };
}

export function useIngestPipeline(options: UseIngestPipelineOptions): UseIngestPipelineReturn {
  const { wsUrl, uiConfig, autoConnect = true, onStatusChange, onRegistryChange } = options;
  
  const clientRef = useRef<WsFeedClient | null>(null);
  const [stage, setStage] = useState('idle');
  const [registry, setRegistry] = useState<RegistryRow[]>([]);
  const [status, setStatus] = useState<FeedStatus | null>(null);
  const [stats, setStats] = useState<PipelineStats>({
    samplesReceived: 0,
    samplesPerSecond: 0,
    seriesCount: 0,
    totalPoints: 0,
    queuedBatches: 0,
  });
  
  // Batch queue for drain loop
  const batchQueueRef = useRef<Sample[][]>([]);
  const drainLoopIdRef = useRef<number | null>(null);
  const lastDrainTimeRef = useRef(0);
  const sampleCounterRef = useRef(0);
  const lastRateCheckRef = useRef(performance.now());
  
  // Configure SeriesStore from UI config
  useEffect(() => {
    if (uiConfig?.data?.buffers) {
      SeriesStore.configure({
        pointsPerSeries: uiConfig.data.buffers.pointsPerSeries,
        maxPointsTotal: uiConfig.data.buffers.maxPointsTotal,
      });
    }
  }, [uiConfig]);
  
  // Handle incoming samples - queue for batch processing
  const handleSamples = useCallback((samples: Sample[]) => {
    // Add to queue
    batchQueueRef.current.push(samples);
    sampleCounterRef.current += samples.length;
    
    // Enforce queue limit from config
    const maxBatches = uiConfig?.ingest?.maxPointsPerBatch || 1000;
    while (batchQueueRef.current.length > maxBatches) {
      batchQueueRef.current.shift(); // Drop oldest
    }
  }, [uiConfig]);
  
  // rAF-based drain loop
  const startDrainLoop = useCallback(() => {
    if (drainLoopIdRef.current !== null) return;
    
    const maxBatchesPerFrame = uiConfig?.uiDrain?.maxBatchesPerFrame || 8;
    const maxMsPerFrame = uiConfig?.uiDrain?.maxMsPerFrame || 6;
    
    const drain = () => {
      const frameStart = performance.now();
      let batchesProcessed = 0;
      
      // Process batches within budget
      while (
        batchQueueRef.current.length > 0 &&
        batchesProcessed < maxBatchesPerFrame &&
        (performance.now() - frameStart) < maxMsPerFrame
      ) {
        const batch = batchQueueRef.current.shift();
        if (batch) {
          // Append to SeriesStore
          SeriesStore.appendSamples(batch);
          batchesProcessed++;
        }
      }
      
      // Update stats periodically
      const now = performance.now();
      if (now - lastRateCheckRef.current > 1000) {
        const elapsed = now - lastRateCheckRef.current;
        const rate = (sampleCounterRef.current / elapsed) * 1000;
        const storeStats = SeriesStore.getStats();
        
        setStats({
          samplesReceived: sampleCounterRef.current,
          samplesPerSecond: Math.round(rate),
          seriesCount: storeStats.seriesCount,
          totalPoints: storeStats.totalPoints,
          queuedBatches: batchQueueRef.current.length,
        });
        
        sampleCounterRef.current = 0;
        lastRateCheckRef.current = now;
      }
      
      drainLoopIdRef.current = requestAnimationFrame(drain);
    };
    
    drainLoopIdRef.current = requestAnimationFrame(drain);
    console.log('[IngestPipeline] Started drain loop');
  }, [uiConfig]);
  
  const stopDrainLoop = useCallback(() => {
    if (drainLoopIdRef.current !== null) {
      cancelAnimationFrame(drainLoopIdRef.current);
      drainLoopIdRef.current = null;
      console.log('[IngestPipeline] Stopped drain loop');
    }
  }, []);
  
  // Handle status updates
  const handleStatus = useCallback((feedStatus: FeedStatus) => {
    setStage(feedStatus.stage);
    setStatus(feedStatus);
    onStatusChange?.(feedStatus);
  }, [onStatusChange]);
  
  // Handle registry updates
  const handleRegistry = useCallback((rows: RegistryRow[]) => {
    setRegistry(rows);
    onRegistryChange?.(rows);
  }, [onRegistryChange]);
  
  // Use reconnecting WebSocket for connection management
  const {
    isConnected: wsConnected,
    isConnecting,
    retryCount,
    nextRetryIn,
    lastError,
    connect: wsConnect,
    disconnect: wsDisconnect,
  } = useReconnectingWebSocket({
    url: wsUrl,
    autoConnect: false, // We manage connection manually
    maxRetries: 10,
    initialDelay: 1000,
    maxDelay: 30000,
    backoffMultiplier: 2,
    onOpen: (ws) => {
      console.log('[IngestPipeline] WebSocket connected via reconnect hook');
      // Create the feed client using the established connection
      if (clientRef.current) {
        clientRef.current.close();
      }
      
      const client = new WsFeedClient({
        url: wsUrl,
        storage: new MemoryStorage(),
        onSamples: handleSamples,
        onStatus: handleStatus,
        onRegistry: handleRegistry,
        onEvent: (evt) => {
          if (evt.type === 'error') {
            console.error('[IngestPipeline] WebSocket error:', evt);
          }
        },
      });
      
      clientRef.current = client;
      client.connect();
      startDrainLoop();
    },
    onClose: (event) => {
      console.log('[IngestPipeline] WebSocket closed:', event.code, event.reason);
      if (!event.wasClean) {
        setStage('reconnecting');
      }
    },
    onError: () => {
      setStage('error');
    },
  });
  
  // Connect to WebSocket
  const connect = useCallback(() => {
    if (clientRef.current) {
      clientRef.current.close();
    }
    
    const client = new WsFeedClient({
      url: wsUrl,
      storage: new MemoryStorage(),
      onSamples: handleSamples,
      onStatus: handleStatus,
      onRegistry: handleRegistry,
      onEvent: (evt) => {
        if (evt.type === 'error') {
          console.error('[IngestPipeline] WebSocket error:', evt);
        }
      },
    });
    
    clientRef.current = client;
    client.connect();
    startDrainLoop();
    
    console.log('[IngestPipeline] Connecting to:', wsUrl);
  }, [wsUrl, handleSamples, handleStatus, handleRegistry, startDrainLoop]);
  
  // Disconnect
  const disconnect = useCallback(() => {
    wsDisconnect();
    clientRef.current?.close();
    clientRef.current = null;
    stopDrainLoop();
    setStage('idle');
    console.log('[IngestPipeline] Disconnected');
  }, [stopDrainLoop, wsDisconnect]);
  
  // Auto-connect on mount
  useEffect(() => {
    if (autoConnect) {
      connect();
    }
    
    return () => {
      disconnect();
    };
  }, [autoConnect]); // Intentionally not including connect/disconnect to avoid reconnection loops
  
  const isConnected = stage === 'live' || stage === 'history' || stage === 'delta';
  
  return {
    stage,
    isConnected,
    stats,
    registry,
    connect,
    disconnect,
    status,
    reconnectState: {
      retryCount,
      nextRetryIn,
      lastError,
    },
  };
}
