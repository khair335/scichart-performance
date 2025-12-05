// Runtime configuration loader for ui-config.json
import type { UIConfig } from '@/types/layout';

const DEFAULT_UI_CONFIG: UIConfig = {
  transport: {
    wsUrl: 'ws://127.0.0.1:8765',
    binary: true,
    useWorker: false,
  },
  ingest: {
    targetTransferHz: 60,
    maxPointsPerBatch: 1000,
  },
  uiDrain: {
    maxBatchesPerFrame: 8,
    maxMsPerFrame: 6,
  },
  data: {
    registry: { enabled: true, maxRows: 1000 },
    buffers: { pointsPerSeries: 100000, maxPointsTotal: 10000000 },
  },
  performance: {
    targetFPS: 60,
    batchSize: 100,
    downsampleRatio: 1,
    maxAutoTicks: 50,
  },
  chart: {
    separateXAxes: false,
    autoScroll: true,
    autoScrollThreshold: 0.95,
    timezone: 'UTC',
  },
  dataCollection: {
    continueWhenPaused: true,
    backgroundBufferSize: 10000,
  },
  minimap: {
    enabled: false,
    overlay: false,
    liveWindowMs: 300000,
  },
  layout: {
    preserveViewportOnReload: true,
    reuseXAxis: true,
  },
  ui: {
    hud: { visible: true, mode: 'full' },
    toolbar: { autoHide: false },
    theme: { default: 'dark', allowToggle: true },
  },
  logging: {
    level: 'info',
    includeStatus: true,
    includeEvents: false,
  },
};

class ConfigLoaderClass {
  private config: UIConfig = DEFAULT_UI_CONFIG;
  private loaded: boolean = false;
  private loading: boolean = false;
  private listeners: Set<(config: UIConfig) => void> = new Set();

  async load(configPath: string = '/ui-config.json'): Promise<UIConfig> {
    if (this.loaded) return this.config;
    if (this.loading) {
      return new Promise((resolve) => {
        const listener = (config: UIConfig) => {
          this.listeners.delete(listener);
          resolve(config);
        };
        this.listeners.add(listener);
      });
    }

    this.loading = true;

    try {
      const response = await fetch(configPath);
      if (response.ok) {
        const json = await response.json();
        this.config = this.mergeConfig(DEFAULT_UI_CONFIG, json);
        console.log('[ConfigLoader] Loaded ui-config.json:', this.config);
      } else {
        console.warn('[ConfigLoader] ui-config.json not found, using defaults');
      }
    } catch (e) {
      console.warn('[ConfigLoader] Failed to load ui-config.json:', e);
    }

    this.loaded = true;
    this.loading = false;
    this.notifyListeners();
    return this.config;
  }

  private mergeConfig(defaults: UIConfig, overrides: Partial<UIConfig>): UIConfig {
    return {
      transport: { ...defaults.transport, ...overrides.transport },
      ingest: { ...defaults.ingest, ...overrides.ingest },
      uiDrain: { ...defaults.uiDrain, ...overrides.uiDrain },
      data: { ...defaults.data, ...overrides.data },
      performance: { ...defaults.performance, ...overrides.performance },
      chart: { ...defaults.chart, ...overrides.chart },
      dataCollection: { ...defaults.dataCollection, ...overrides.dataCollection },
      minimap: { ...defaults.minimap, ...overrides.minimap },
      layout: { ...defaults.layout, ...overrides.layout },
      ui: { ...defaults.ui, ...overrides.ui },
      logging: { ...defaults.logging, ...overrides.logging },
    };
  }

  getConfig(): UIConfig {
    return this.config;
  }

  isLoaded(): boolean {
    return this.loaded;
  }

  subscribe(listener: (config: UIConfig) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) {
      listener(this.config);
    }
  }
}

export const ConfigLoader = new ConfigLoaderClass();
