// Simple test page to verify SciChart rendering works correctly
import { useEffect, useRef, useState } from 'react';
import {
  SciChartSurface,
  NumericAxis,
  FastLineRenderableSeries,
  FastCandlestickRenderableSeries,
  FastMountainRenderableSeries,
  XyDataSeries,
  OhlcDataSeries,
  EAutoRange,
  NumberRange,
} from 'scichart';

// Generate dummy test data
function generateTestData() {
  const baseTime = Date.now() / 1000; // Current time in seconds
  const numPoints = 1000;
  
  // Price ticks around 100
  const ticks = {
    x: [] as number[],
    y: [] as number[],
  };
  
  // SMA around 100
  const sma = {
    x: [] as number[],
    y: [] as number[],
  };
  
  // OHLC bars
  const ohlc = {
    x: [] as number[],
    o: [] as number[],
    h: [] as number[],
    l: [] as number[],
    c: [] as number[],
  };
  
  // PnL values
  const pnl = {
    x: [] as number[],
    y: [] as number[],
  };
  
  let price = 100;
  let smaValue = 100;
  let pnlValue = 0;
  
  for (let i = 0; i < numPoints; i++) {
    const t = baseTime - (numPoints - i); // Time in seconds, going back numPoints seconds
    
    // Tick data - random walk around 100
    price += (Math.random() - 0.5) * 0.5;
    ticks.x.push(t);
    ticks.y.push(price);
    
    // SMA - smoothed version
    smaValue = smaValue * 0.95 + price * 0.05;
    sma.x.push(t);
    sma.y.push(smaValue);
    
    // PnL - random walk around 0
    pnlValue += (Math.random() - 0.5) * 2;
    pnl.x.push(t);
    pnl.y.push(pnlValue);
  }
  
  // OHLC - 10 second bars
  for (let i = 0; i < numPoints; i += 10) {
    const barTime = baseTime - (numPoints - i);
    const barPrices = ticks.y.slice(i, Math.min(i + 10, numPoints));
    if (barPrices.length === 0) continue;
    
    ohlc.x.push(barTime);
    ohlc.o.push(barPrices[0]);
    ohlc.h.push(Math.max(...barPrices));
    ohlc.l.push(Math.min(...barPrices));
    ohlc.c.push(barPrices[barPrices.length - 1]);
  }
  
  return { ticks, sma, ohlc, pnl };
}

export default function ChartTest() {
  const priceChartRef = useRef<HTMLDivElement>(null);
  const ohlcChartRef = useRef<HTMLDivElement>(null);
  const pnlChartRef = useRef<HTMLDivElement>(null);
  
  const [status, setStatus] = useState<string[]>([]);
  const [surfaces, setSurfaces] = useState<SciChartSurface[]>([]);
  
  const addStatus = (msg: string) => {
    console.log(`[ChartTest] ${msg}`);
    setStatus(prev => [...prev, msg]);
  };
  
  useEffect(() => {
    let mounted = true;
    const createdSurfaces: SciChartSurface[] = [];
    
    async function initCharts() {
      if (!priceChartRef.current || !ohlcChartRef.current || !pnlChartRef.current) {
        addStatus('ERROR: Missing chart containers');
        return;
      }
      
      try {
        addStatus('Generating test data...');
        const data = generateTestData();
        addStatus(`Generated: ${data.ticks.x.length} ticks, ${data.ohlc.x.length} OHLC bars, ${data.pnl.x.length} PnL points`);
        addStatus(`Ticks X range: ${data.ticks.x[0].toFixed(0)} - ${data.ticks.x[data.ticks.x.length-1].toFixed(0)}`);
        addStatus(`Ticks Y range: ${Math.min(...data.ticks.y).toFixed(2)} - ${Math.max(...data.ticks.y).toFixed(2)}`);
        
        // Create Price Chart
        addStatus('Creating price chart...');
        const { sciChartSurface: priceSurface, wasmContext: priceWasm } = await SciChartSurface.create(
          priceChartRef.current,
          { theme: { type: 'Dark' } }
        );
        createdSurfaces.push(priceSurface);
        
        if (!mounted) {
          priceSurface.delete();
          return;
        }
        
        // Add axes to price chart
        const priceXAxis = new NumericAxis(priceWasm, { 
          axisTitle: 'Time',
          autoRange: EAutoRange.Always,
        });
        const priceYAxis = new NumericAxis(priceWasm, { 
          axisTitle: 'Price',
          autoRange: EAutoRange.Always,
        });
        priceSurface.xAxes.add(priceXAxis);
        priceSurface.yAxes.add(priceYAxis);
        
        // Add ticks series
        const ticksDataSeries = new XyDataSeries(priceWasm, { dataSeriesName: 'Ticks' });
        ticksDataSeries.appendRange(data.ticks.x, data.ticks.y);
        addStatus(`Ticks DataSeries has ${ticksDataSeries.count()} points`);
        
        const ticksSeries = new FastLineRenderableSeries(priceWasm, {
          dataSeries: ticksDataSeries,
          stroke: '#50C7E0',
          strokeThickness: 2,
        });
        priceSurface.renderableSeries.add(ticksSeries);
        addStatus(`Price chart has ${priceSurface.renderableSeries.size()} series`);
        
        // Add SMA series
        const smaDataSeries = new XyDataSeries(priceWasm, { dataSeriesName: 'SMA' });
        smaDataSeries.appendRange(data.sma.x, data.sma.y);
        
        const smaSeries = new FastLineRenderableSeries(priceWasm, {
          dataSeries: smaDataSeries,
          stroke: '#F48420',
          strokeThickness: 2,
        });
        priceSurface.renderableSeries.add(smaSeries);
        
        // Zoom to data
        priceSurface.zoomExtents();
        addStatus(`Price chart Y axis: ${priceYAxis.visibleRange.min.toFixed(2)} - ${priceYAxis.visibleRange.max.toFixed(2)}`);
        
        // Create OHLC Chart
        addStatus('Creating OHLC chart...');
        const { sciChartSurface: ohlcSurface, wasmContext: ohlcWasm } = await SciChartSurface.create(
          ohlcChartRef.current,
          { theme: { type: 'Dark' } }
        );
        createdSurfaces.push(ohlcSurface);
        
        if (!mounted) {
          ohlcSurface.delete();
          return;
        }
        
        // Add axes to OHLC chart
        const ohlcXAxis = new NumericAxis(ohlcWasm, { autoRange: EAutoRange.Always });
        const ohlcYAxis = new NumericAxis(ohlcWasm, { autoRange: EAutoRange.Always });
        ohlcSurface.xAxes.add(ohlcXAxis);
        ohlcSurface.yAxes.add(ohlcYAxis);
        
        // Add OHLC series
        const ohlcDataSeries = new OhlcDataSeries(ohlcWasm, { dataSeriesName: 'OHLC' });
        ohlcDataSeries.appendRange(data.ohlc.x, data.ohlc.o, data.ohlc.h, data.ohlc.l, data.ohlc.c);
        addStatus(`OHLC DataSeries has ${ohlcDataSeries.count()} points`);
        
        const ohlcSeries = new FastCandlestickRenderableSeries(ohlcWasm, {
          dataSeries: ohlcDataSeries,
          strokeUp: '#26a69a',
          brushUp: '#26a69a88',
          strokeDown: '#ef5350',
          brushDown: '#ef535088',
        });
        ohlcSurface.renderableSeries.add(ohlcSeries);
        ohlcSurface.zoomExtents();
        addStatus(`OHLC chart Y axis: ${ohlcYAxis.visibleRange.min.toFixed(2)} - ${ohlcYAxis.visibleRange.max.toFixed(2)}`);
        
        // Create PnL Chart
        addStatus('Creating PnL chart...');
        const { sciChartSurface: pnlSurface, wasmContext: pnlWasm } = await SciChartSurface.create(
          pnlChartRef.current,
          { theme: { type: 'Dark' } }
        );
        createdSurfaces.push(pnlSurface);
        
        if (!mounted) {
          pnlSurface.delete();
          return;
        }
        
        // Add axes to PnL chart
        const pnlXAxis = new NumericAxis(pnlWasm, { autoRange: EAutoRange.Always });
        const pnlYAxis = new NumericAxis(pnlWasm, { autoRange: EAutoRange.Always });
        pnlSurface.xAxes.add(pnlXAxis);
        pnlSurface.yAxes.add(pnlYAxis);
        
        // Add PnL series
        const pnlDataSeries = new XyDataSeries(pnlWasm, { dataSeriesName: 'PnL' });
        pnlDataSeries.appendRange(data.pnl.x, data.pnl.y);
        
        const pnlSeries = new FastMountainRenderableSeries(pnlWasm, {
          dataSeries: pnlDataSeries,
          stroke: '#4CAF50',
          strokeThickness: 2,
          fill: '#4CAF5033',
        });
        pnlSurface.renderableSeries.add(pnlSeries);
        pnlSurface.zoomExtents();
        addStatus(`PnL chart Y axis: ${pnlYAxis.visibleRange.min.toFixed(2)} - ${pnlYAxis.visibleRange.max.toFixed(2)}`);
        
        addStatus('All charts created successfully!');
        setSurfaces(createdSurfaces);
        
      } catch (error) {
        addStatus(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
        console.error('[ChartTest] Error:', error);
      }
    }
    
    initCharts();
    
    return () => {
      mounted = false;
      createdSurfaces.forEach(s => s.delete());
    };
  }, []);
  
  return (
    <div className="h-screen w-screen bg-background text-foreground p-4 flex flex-col">
      <h1 className="text-xl font-bold mb-4">SciChart Rendering Test</h1>
      
      <div className="flex-1 grid grid-rows-3 gap-4 min-h-0">
        <div className="bg-card rounded-lg overflow-hidden border border-border">
          <div className="px-2 py-1 text-sm font-medium bg-muted">Price Chart (Line)</div>
          <div ref={priceChartRef} className="h-[calc(100%-28px)] w-full" />
        </div>
        
        <div className="bg-card rounded-lg overflow-hidden border border-border">
          <div className="px-2 py-1 text-sm font-medium bg-muted">OHLC Chart (Candlestick)</div>
          <div ref={ohlcChartRef} className="h-[calc(100%-28px)] w-full" />
        </div>
        
        <div className="bg-card rounded-lg overflow-hidden border border-border">
          <div className="px-2 py-1 text-sm font-medium bg-muted">PnL Chart (Mountain)</div>
          <div ref={pnlChartRef} className="h-[calc(100%-28px)] w-full" />
        </div>
      </div>
      
      <div className="mt-4 p-2 bg-muted rounded text-xs font-mono max-h-40 overflow-auto">
        {status.map((s, i) => (
          <div key={i} className={s.startsWith('ERROR') ? 'text-red-400' : ''}>{s}</div>
        ))}
      </div>
    </div>
  );
}
