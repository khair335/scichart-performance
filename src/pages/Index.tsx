import { Helmet } from 'react-helmet-async';
import { TradingChart } from '@/components/chart/TradingChart';

const Index = () => {
  return (
    <>
      <Helmet>
        <title>SciChart Real-Time Trading Terminal</title>
        <meta name="description" content="High-performance real-time charting UI for market data visualization with SciChart JS" />
      </Helmet>
      
      <TradingChart wsUrl="ws://127.0.0.1:8765" />
    </>
  );
};

export default Index;
