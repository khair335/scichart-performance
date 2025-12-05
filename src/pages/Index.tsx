import { Helmet } from 'react-helmet-async';
import { TradingChartV2 } from '@/components/chart/TradingChartV2';
import { useEffect, useState } from 'react';
import type { UIConfig } from '@/types/layout';

const Index = () => {
  const [config, setConfig] = useState<Record<string, unknown> | null>(null);
  const [uiConfig, setUIConfig] = useState<UIConfig | null>(null);
  
  // Load config.json and ui-config.json on startup
  useEffect(() => {
    Promise.all([
      fetch('/config.json').then(res => res.json()).catch(() => ({})),
      fetch('/ui-config.json').then(res => res.json()).catch(() => ({}))
    ]).then(([cfg, uiCfg]) => {
      console.log('[Index] Config loaded:', cfg);
      console.log('[Index] UI Config loaded:', uiCfg);
      setConfig(cfg);
      setUIConfig(uiCfg as UIConfig);
    }).catch(err => {
      console.warn('[Index] Config files not found, using defaults:', err);
      setConfig({});
      setUIConfig({} as UIConfig);
    });
  }, []);
  
  if (!config || !uiConfig) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="text-center">
          <div className="w-16 h-16 border-3 border-primary border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-muted-foreground">Loading configuration...</p>
        </div>
      </div>
    );
  }
  
  // Get WebSocket URL from ui-config, environment variable, or default
  const wsUrl = uiConfig?.transport?.wsUrl || import.meta.env.VITE_WS_URL || 'ws://127.0.0.1:8765';
  
  return (
    <>
      <Helmet>
        <title>SciChart Real-Time Trading Terminal</title>
        <meta name="description" content="High-performance real-time charting UI for market data visualization with SciChart JS" />
      </Helmet>
      
      <TradingChartV2 wsUrl={wsUrl} uiConfig={uiConfig} />
    </>
  );
};

export default Index;
