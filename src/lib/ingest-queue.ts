// Ingest Queue with rAF Drain Loop
// Implements buffered batch processing for optimal chart performance

import type { Sample } from './wsfeed-client';

export interface IngestQueueConfig {
  maxBatchesPerFrame: number;
  maxMsPerFrame: number;
  maxQueueSize: number;
  dropPolicy: 'oldest' | 'newest';
}

export interface IngestQueueStats {
  queued: number;
  dropped: number;
  drained: number;
  avgDrainTimeMs: number;
}

export type DrainCallback = (samples: Sample[]) => void;

const DEFAULT_CONFIG: IngestQueueConfig = {
  maxBatchesPerFrame: 10,
  maxMsPerFrame: 8, // ~60fps budget
  maxQueueSize: 100000,
  dropPolicy: 'oldest',
};

export class IngestQueue {
  private queue: Sample[][] = [];
  private config: IngestQueueConfig;
  private drainCallback: DrainCallback | null = null;
  private rafId: number | null = null;
  private running = false;
  
  // Stats
  private droppedCount = 0;
  private drainedCount = 0;
  private drainTimes: number[] = [];

  constructor(config: Partial<IngestQueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Start the drain loop
   */
  start(onDrain: DrainCallback): void {
    this.drainCallback = onDrain;
    this.running = true;
    this.scheduleDrain();
  }

  /**
   * Stop the drain loop
   */
  stop(): void {
    this.running = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /**
   * Enqueue a batch of samples
   */
  enqueue(samples: Sample[]): void {
    if (!samples.length) return;

    // Check queue size limit
    const totalQueued = this.queue.reduce((sum, batch) => sum + batch.length, 0);
    
    if (totalQueued + samples.length > this.config.maxQueueSize) {
      // Apply drop policy
      if (this.config.dropPolicy === 'oldest') {
        // Drop oldest batches until we have space
        while (this.queue.length > 0 && 
               this.queue.reduce((sum, b) => sum + b.length, 0) + samples.length > this.config.maxQueueSize) {
          const dropped = this.queue.shift();
          if (dropped) this.droppedCount += dropped.length;
        }
      } else {
        // Drop the incoming batch
        this.droppedCount += samples.length;
        return;
      }
    }

    this.queue.push(samples);
  }

  /**
   * Get queue statistics
   */
  getStats(): IngestQueueStats {
    const avgDrain = this.drainTimes.length > 0
      ? this.drainTimes.reduce((a, b) => a + b, 0) / this.drainTimes.length
      : 0;

    return {
      queued: this.queue.reduce((sum, batch) => sum + batch.length, 0),
      dropped: this.droppedCount,
      drained: this.drainedCount,
      avgDrainTimeMs: Math.round(avgDrain * 100) / 100,
    };
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
  }

  private scheduleDrain(): void {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(() => this.drain());
  }

  private drain(): void {
    if (!this.running || !this.drainCallback) {
      this.scheduleDrain();
      return;
    }

    const startTime = performance.now();
    let batchesProcessed = 0;
    const allSamples: Sample[] = [];

    // Process batches within budget
    while (
      this.queue.length > 0 &&
      batchesProcessed < this.config.maxBatchesPerFrame &&
      performance.now() - startTime < this.config.maxMsPerFrame
    ) {
      const batch = this.queue.shift();
      if (batch) {
        allSamples.push(...batch);
        batchesProcessed++;
      }
    }

    // Deliver to callback if we have data
    if (allSamples.length > 0) {
      try {
        this.drainCallback(allSamples);
        this.drainedCount += allSamples.length;
      } catch (err) {
        console.error('[IngestQueue] Drain callback error:', err);
      }
    }

    // Track drain time
    const drainTime = performance.now() - startTime;
    this.drainTimes.push(drainTime);
    if (this.drainTimes.length > 60) {
      this.drainTimes.shift();
    }

    // Schedule next drain
    this.scheduleDrain();
  }
}
