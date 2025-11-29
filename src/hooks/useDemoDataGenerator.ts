import { useEffect, useRef, useCallback, useState } from 'react';
import type { Sample } from '@/lib/wsfeed-client';

interface UseDemoDataGeneratorOptions {
  enabled: boolean;
  ticksPerSecond?: number;
  basePrice?: number;
  onSamples: (samples: Sample[]) => void;
}

export function useDemoDataGenerator({
  enabled,
  ticksPerSecond = 50,
  basePrice = 6000,
  onSamples,
}: UseDemoDataGeneratorOptions) {
  const [isRunning, setIsRunning] = useState(false);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const stateRef = useRef({
    seq: 0,
    price: basePrice,
    lastOhlcTime: 0,
    ohlc: { o: basePrice, h: basePrice, l: basePrice, c: basePrice },
    smaPeriod: 10,
    smaBuffer: [] as number[],
  });

  const generateSamples = useCallback(() => {
    const state = stateRef.current;
    const now = Date.now();
    const samples: Sample[] = [];

    // Generate tick
    const priceChange = (Math.random() - 0.5) * 2; // Random walk
    state.price = Math.max(5500, Math.min(6500, state.price + priceChange));
    state.seq++;

    const tickSample: Sample = {
      seq: state.seq,
      series_id: 'DEMO:ticks',
      t_ms: now,
      payload: { price: state.price, volume: Math.floor(Math.random() * 100) + 1 },
      series_seq: state.seq,
    };
    samples.push(tickSample);

    // Update SMA buffer
    state.smaBuffer.push(state.price);
    if (state.smaBuffer.length > state.smaPeriod) {
      state.smaBuffer.shift();
    }

    // Generate SMA if we have enough data
    if (state.smaBuffer.length >= state.smaPeriod) {
      const smaValue = state.smaBuffer.reduce((a, b) => a + b, 0) / state.smaPeriod;
      state.seq++;
      samples.push({
        seq: state.seq,
        series_id: 'DEMO:sma_10',
        t_ms: now,
        payload: { value: smaValue },
        series_seq: Math.floor(state.seq / 2),
      });
    }

    // Update OHLC (10 second bars)
    const barInterval = 10000;
    const currentBarStart = Math.floor(now / barInterval) * barInterval;

    if (state.lastOhlcTime !== currentBarStart) {
      // Emit previous bar if exists
      if (state.lastOhlcTime > 0) {
        state.seq++;
        samples.push({
          seq: state.seq,
          series_id: 'DEMO:ohlc_time:10000',
          t_ms: state.lastOhlcTime,
          payload: { ...state.ohlc },
          series_seq: Math.floor(state.seq / 50),
        });
      }
      
      // Start new bar
      state.ohlc = { o: state.price, h: state.price, l: state.price, c: state.price };
      state.lastOhlcTime = currentBarStart;
    } else {
      // Update current bar
      state.ohlc.h = Math.max(state.ohlc.h, state.price);
      state.ohlc.l = Math.min(state.ohlc.l, state.price);
      state.ohlc.c = state.price;
    }

    return samples;
  }, []);

  useEffect(() => {
    if (enabled) {
      setIsRunning(true);
      const interval = 1000 / ticksPerSecond;
      
      intervalRef.current = setInterval(() => {
        const samples = generateSamples();
        onSamples(samples);
      }, interval);

      return () => {
        if (intervalRef.current) {
          clearInterval(intervalRef.current);
        }
        setIsRunning(false);
      };
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
      setIsRunning(false);
    }
  }, [enabled, ticksPerSecond, generateSamples, onSamples]);

  return { isRunning };
}
