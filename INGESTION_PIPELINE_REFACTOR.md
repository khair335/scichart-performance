# Data Ingestion Pipeline Refactoring Plan

## Current Issues

1. **No Unified DataSeries Store**
   - Tick and OHLC are hardcoded as single DataSeries
   - Indicators stored in separate Maps (`tickIndicatorDataSeries`, `barIndicatorDataSeries`)
   - No single source of truth: `Map<series_id, DataSeries>`

2. **No Proactive Preallocation**
   - DataSeries created on-demand when data arrives (lines 922-944)
   - Should preallocate when series discovered in registry
   - Registry is available but not used for preallocation

3. **Pipeline Not Clear**
   - Current: WS → `appendSamples` → `sampleBufferRef` → `processBatchedSamples` → DataSeries
   - Should be: WS → Ingest Queue → rAF Drain → DataSeries Store → Chart

4. **UI Config Structure**
   - Current structure is simplified
   - Should match requirements with `data.buffers.pointsPerSeries` (1M default)

## Proposed Solution

### 1. Unified DataSeries Store
```typescript
interface DataSeriesEntry {
  dataSeries: XyDataSeries | OhlcDataSeries;
  renderableSeries: FastLineRenderableSeries | FastCandlestickRenderableSeries;
  chartTarget: 'tick' | 'ohlc';
  seriesType: 'tick' | 'ohlc-bar' | 'tick-indicator' | 'bar-indicator' | 'strategy-marker' | 'strategy-signal' | 'strategy-pnl';
}

// Single store for ALL series
dataSeriesStore: Map<string, DataSeriesEntry>
```

### 2. Registry-Based Preallocation
```typescript
// Listen to registry changes
useEffect(() => {
  if (!registry || registry.length === 0) return;
  
  registry.forEach(regEntry => {
    const seriesId = regEntry.id;
    
    // If series not in store, preallocate it
    if (!chartRefs.current.dataSeriesStore.has(seriesId)) {
      const seriesInfo = parseSeriesType(seriesId);
      const capacity = config.data.buffers.pointsPerSeries; // 1M default
      
      // Create DataSeries with preallocated buffer
      const dataSeries = createDataSeriesForType(seriesInfo, capacity);
      const renderableSeries = createRenderableSeriesForType(seriesInfo, dataSeries);
      
      // Add to store
      chartRefs.current.dataSeriesStore.set(seriesId, {
        dataSeries,
        renderableSeries,
        chartTarget: seriesInfo.chartTarget,
        seriesType: seriesInfo.type,
      });
      
      // Add to appropriate chart surface
      const surface = seriesInfo.chartTarget === 'tick' 
        ? chartRefs.current.tickSurface 
        : chartRefs.current.ohlcSurface;
      surface?.renderableSeries.add(renderableSeries);
    }
  });
}, [registry]);
```

### 3. Simplified Data Processing
```typescript
// In processBatchedSamples:
for (const sample of samples) {
  const entry = chartRefs.current.dataSeriesStore.get(sample.series_id);
  if (!entry) continue; // Series not preallocated yet (shouldn't happen)
  
  // Append to preallocated DataSeries
  if (entry.seriesType === 'ohlc-bar') {
    (entry.dataSeries as OhlcDataSeries).append(t_ms, o, h, l, c);
  } else {
    (entry.dataSeries as XyDataSeries).append(t_ms, value);
  }
}
```

### 4. Updated UI Config
```json
{
  "data": {
    "buffers": {
      "pointsPerSeries": 1000000,  // Preallocation for ALL series
      "maxPointsTotal": 10000000    // Global cap
    }
  }
}
```

## Implementation Steps

1. ✅ Update UI config JSON structure
2. ⏳ Refactor ChartRefs to use unified DataSeries Store
3. ⏳ Add registry listener to preallocate buffers
4. ⏳ Refactor data processing to use unified store
5. ⏳ Remove old separate Maps and hardcoded series

## Benefits

- **Proactive preallocation**: Buffers ready before data arrives
- **Unified store**: Single source of truth for all series
- **Dynamic discovery**: Automatically handles any series type
- **Cleaner pipeline**: Clear separation of concerns
- **Better performance**: No on-demand creation overhead




