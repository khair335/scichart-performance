# SciChart.js Official Best Practices for Large Data Performance

This document outlines the **official SciChart.js best practices** from their performance tips guide and examples, specifically for handling large datasets and real-time data.

## ✅ **DataSeries Optimizations** (CRITICAL for Large Data)

### 1.1 Data Distribution Flags (LARGE IMPACT)
**Official Recommendation**: Always specify data properties to avoid detection overhead.

```typescript
new XyDataSeries(wasmContext, {
  dataIsSortedInX: true,        // ✅ Time-series data is sorted
  dataEvenlySpacedInX: true,   // ✅ Time-series data is evenly spaced
  containsNaN: false,          // ✅ No NaN values
  capacity: 1_000_000,         // ✅ Pre-allocate capacity
  fifoCapacity: 500_000,       // ✅ Use FIFO for real-time data
})
```

**Performance Impact**: 
- Without flags: 55ms to create 1M points
- With flags: 11ms to create 1M points (5x faster!)

**✅ Our Implementation**: Already implemented in `MultiPaneChart.tsx` lines 527-553

---

### 1.2 Batch Updates (LARGE IMPACT)
**Official Recommendation**: Always use `appendRange()` instead of `append()`.

```typescript
// ❌ BAD: 69ms for 100k points
for (let i = 0; i < 100000; i++) {
  series.append(x[i], y[i]);
}

// ✅ GOOD: 1ms for 100k points
series.appendRange(xValues, yValues);
```

**Performance Impact**: 69x faster for batch operations!

**✅ Our Implementation**: Already using `appendRange()` throughout

---

### 1.3 Capacity Pre-allocation (SMALL IMPACT)
**Official Recommendation**: Pre-allocate capacity to avoid geometric resizing.

```typescript
// ✅ Pre-allocate 1M capacity
new XyDataSeries(wasmContext, { capacity: 1_000_000 })
```

**Performance Impact**: 22ms → 15ms (30% faster)

**✅ Our Implementation**: Already using `capacity` parameter

---

### 1.4 FIFO Capacity (SMALL IMPACT for Real-time)
**Official Recommendation**: Use FIFO for scrolling/sweeping charts.

```typescript
new XyDataSeries(wasmContext, { fifoCapacity: 500_000 })
```

**Performance Impact**: Reduces memory usage and improves performance for long-running sessions.

**✅ Our Implementation**: Already using `fifoCapacity` when enabled

---

### 1.5 Float64Array (SMALL IMPACT)
**Official Recommendation**: Use `Float64Array` instead of regular arrays.

```typescript
// ✅ Use Float64Array
const xValues = new Float64Array(count);
const yValues = new Float64Array(count);
series.appendRange(xValues, yValues);
```

**Performance Impact**: 24ms → 21ms (12% faster)

**✅ Our Implementation**: Using `Float64Array.from()` for conversions

---

### 1.6 Buffer Reuse (SMALL IMPACT)
**Official Recommendation**: Reuse buffers instead of creating new ones.

```typescript
// ✅ Allocate once, reuse
const xBuffer = new Float64Array(10000);
const yBuffer = new Float64Array(10000);
// Reuse in loop...
```

**Performance Impact**: 40ms → 24ms (40% faster)

**⚠️ Our Implementation**: Could be improved - currently creating new arrays each time

---

## ✅ **Multi-Chart Optimizations**

### 2.1 Freeze When Out of View (LARGE IMPACT)
**Official Recommendation**: Use `freezeWhenOutOfView` for charts in scroll views.

```typescript
SciChartSurface.create(containerId, {
  freezeWhenOutOfView: true  // ✅ Freeze off-screen charts
})
```

**✅ Our Implementation**: Already implemented in `dynamic-pane-manager.ts` line 104

---

### 2.2 SubCharts API (LARGE IMPACT)
**Official Recommendation**: Use SubCharts API to share WebGL context.

```typescript
// ✅ Use SubCharts for multiple panes
const parentSurface = await SciChartSurface.create(containerId);
const subSurface = SciChartSubSurface.createSubSurface(parentSurface, {...});
```

**Performance Impact**: Fewer WebGL calls, better performance in Firefox/Safari.

**✅ Our Implementation**: Already using SubCharts API via `DynamicPaneManager`

---

### 2.3 Reduce Axis Elements (MODERATE IMPACT)
**Official Recommendation**: Reduce ticks, gridlines, labels for multi-chart scenarios.

```typescript
new NumericAxis(wasmContext, {
  maxAutoTicks: 3,              // ✅ Reduce tick count
  drawMinorGridLines: false,    // ✅ Disable minor gridlines
  drawMinorTickLines: false,    // ✅ Disable minor ticks
})
```

**✅ Our Implementation**: Already implemented in `dynamic-pane-manager.ts`

---

### 2.4 WebGL Context Strategy
**Official Recommendation**: 
- `create()` = Shared WebGL (better for many charts, lower memory)
- `createSingle()` = Individual WebGL (faster rendering, limited to 16 contexts in Chrome)

**✅ Our Implementation**: Using `create()` for SubCharts (correct for multi-chart)

---

## ✅ **Text Label Optimizations**

### 3.1 Native Text (LARGE IMPACT)
**Official Recommendation**: Enable native WebGL text labels.

```typescript
SciChartDefaults.useNativeText = true;  // ✅ Global setting
// OR per-axis:
new NumericAxis(wasmContext, { useNativeText: true })
```

**✅ Our Implementation**: Already enabled globally in `MultiPaneChart.tsx` line 851

---

### 3.2 Shared Label Cache (MODERATE IMPACT)
**Official Recommendation**: Share label cache across charts.

```typescript
SciChartDefaults.useSharedCache = true;  // ✅ Global setting
// OR per-axis:
new NumericAxis(wasmContext, { useSharedCache: true })
```

**✅ Our Implementation**: Already enabled globally in `MultiPaneChart.tsx` line 852

---

## ✅ **Miscellaneous Optimizations**

### 4.1 Browser Choice
**Official Recommendation**: Use Google Chrome for best performance.

**Performance Impact**: Chrome is significantly faster than Safari/Firefox for WebGL/WebAssembly.

---

### 4.2 DPI Scaling (MODERATE IMPACT on Retina)
**Official Recommendation**: Disable DPI scaling on Retina displays if performance is an issue.

```typescript
import { DpiHelper } from "scichart";
DpiHelper.IsDpiScaleEnabled = false;  // ✅ Disable before creating surfaces
```

**✅ Our Implementation**: Already disabled in `MultiPaneChart.tsx` line 848

---

## 📊 **Official Example: Real-time Performance Demo**

From `Realtime JavaScript Chart Performance Demo.txt`:

```typescript
// ✅ Official pattern for high-frequency updates:
const numberOfPointsPerTimerTick = 1000;  // 1,000 points per update
const timerInterval = 10;                 // Every 10ms (100 updates/sec)

// ✅ Use createSingle() for single chart (faster)
const { sciChartSurface } = await SciChartSurface.createSingle(rootElement, {...});

// ✅ DataSeries with flags
const dataSeries = new XyDataSeries(wasmContext, {
  containsNaN: false,
  isSorted: true  // Note: Official example uses isSorted, not dataIsSortedInX
});

// ✅ Batch append
dataSeries.appendRange(xValues, yValues);

// ✅ Measure performance
sciChartSurface.renderedToDestination.subscribe(() => {
  // Calculate FPS, render time, etc.
});
```

**Key Insights**:
- 1,000 points every 10ms = 100,000 points/second
- Uses `createSingle()` for maximum performance (single chart scenario)
- Measures render time via `renderedToDestination` event

---

## 📊 **Official Example: 64-Chart Dashboard**

From `drawerexample.ts`:

```typescript
// ✅ SubCharts pattern for 64 charts (8x8 grid)
const mainSurface = await SciChartSurface.createSingle(rootElement, {...});

// ✅ Create sub-charts with relative positioning
const subSurface = SciChartSubSurface.createSubSurface(mainSurface, {
  position: new Rect(columnIndex * width, rowIndex * height, width, height),
  coordinateMode: ESubSurfacePositionCoordinateMode.Relative,
});

// ✅ Performance measurement
mainSurface.preRenderAll.subscribe(() => {
  renderStart = performance.now();
});

mainSurface.renderedToDestination.subscribe(() => {
  avgRenderTime = performance.now() - renderStart;
  // Report: Generate time, Append time, Render time, Max FPS
});
```

**Key Insights**:
- Uses SubCharts API for 64 charts
- Measures: Generate time, Append time, Render time separately
- Calculates "Max FPS" = 1000 / (appendTime + renderTime)

---

## 🎯 **Recommended Configuration for Large Data**

Based on official best practices:

```typescript
// DataSeries Configuration
const dataSeriesConfig = {
  dataIsSortedInX: true,        // ✅ REQUIRED
  dataEvenlySpacedInX: true,    // ✅ REQUIRED for time-series
  containsNaN: false,           // ✅ REQUIRED
  capacity: 1_000_000,          // ✅ Pre-allocate
  fifoCapacity: 500_000,        // ✅ For real-time (8-hour sessions)
};

// RenderableSeries Configuration
const renderableSeriesConfig = {
  resamplingMode: EResamplingMode.Auto,  // ✅ Auto-resampling for large data
};

// Surface Configuration
const surfaceConfig = {
  freezeWhenOutOfView: true,    // ✅ For scroll views
  // Use create() for SubCharts, createSingle() for single chart
};

// Axis Configuration
const axisConfig = {
  useNativeText: true,           // ✅ REQUIRED
  useSharedCache: true,          // ✅ REQUIRED
  maxAutoTicks: 3,               // ✅ Reduced for performance
  drawMinorGridLines: false,     // ✅ Disabled
  drawMinorTickLines: false,     // ✅ Disabled
};

// Global Settings
SciChartDefaults.useNativeText = true;
SciChartDefaults.useSharedCache = true;
DpiHelper.IsDpiScaleEnabled = false;  // ✅ For Retina displays
```

---

## ✅ **Current Implementation Status**

| Best Practice | Status | Location |
|--------------|--------|----------|
| DataSeries flags (dataIsSortedInX, etc.) | ✅ Implemented | MultiPaneChart.tsx:527-553 |
| Batch updates (appendRange) | ✅ Implemented | MultiPaneChart.tsx:2947-3003 |
| Capacity pre-allocation | ✅ Implemented | MultiPaneChart.tsx:530,549 |
| FIFO capacity | ✅ Implemented | MultiPaneChart.tsx:529,548 |
| Float64Array usage | ✅ Implemented | MultiPaneChart.tsx:2947-2976 |
| Buffer reuse | ⚠️ Could improve | Currently creating new arrays |
| Freeze when out of view | ✅ Implemented | dynamic-pane-manager.ts:104 |
| SubCharts API | ✅ Implemented | DynamicPaneManager class |
| Reduce axis elements | ✅ Implemented | dynamic-pane-manager.ts:354-397 |
| Native text | ✅ Implemented | MultiPaneChart.tsx:851 |
| Shared label cache | ✅ Implemented | MultiPaneChart.tsx:852 |
| DPI scaling disabled | ✅ Implemented | MultiPaneChart.tsx:848 |

---

## 🚀 **Next Steps for Maximum Performance**

1. **Implement buffer reuse** (1.6) - Reuse Float64Array buffers instead of creating new ones
2. **Consider createSingle()** for single-chart scenarios (if not using SubCharts)
3. **Monitor render times** like official examples (preRenderAll + renderedToDestination)
4. **Tune FIFO capacity** based on actual data rates (500K for 8-hour sessions)

---

## 📚 **References**

- Official Performance Tips: `example/perfomanceTips.txt`
- Real-time Demo: `example/Realtime JavaScript Chart Performance Demo.txt`
- 64-Chart Dashboard: `example/drawerexample.ts`
- SciChart Documentation: https://www.scichart.com/documentation/js/



