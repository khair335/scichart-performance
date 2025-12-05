import { Helmet } from 'react-helmet-async';
import { TradingChart } from '@/components/chart/TradingChart';
import { useEffect, useState } from 'react';

const Index = () => {
  const [config, setConfig] = useState<any>(null);
  const [uiConfig, setUIConfig] = useState<any>(null);
  
  // Load config.json and ui-config.json on startup
  useEffect(() => {
    Promise.all([
      fetch('/config.json').then(res => res.json()).catch(() => ({})),
      fetch('/ui-config.json').then(res => res.json()).catch(() => ({}))
    ]).then(([cfg, uiCfg]) => {
      console.log('Config loaded:', cfg);
      console.log('UI Config loaded:', uiCfg);
      setConfig(cfg);
      setUIConfig(uiCfg);
    }).catch(err => {
      console.warn('Config files not found, using defaults:', err);
      setConfig({});
      setUIConfig({});
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
  
  // Get WebSocket URL from environment variable, config.json, or default
  const wsUrl = import.meta.env.VITE_WS_URL || config.wsUrl || 'ws://127.0.0.1:8765';
  
  return (
    <>
      <Helmet>
        <title>SciChart Real-Time Trading Terminal</title>
        <meta name="description" content="High-performance real-time charting UI for market data visualization with SciChart JS" />
      </Helmet>
      
      <TradingChart wsUrl={wsUrl} uiConfig={uiConfig} />
    </>
  );
};

export default Index;
