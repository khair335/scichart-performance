# X-Axis Range Management & SciChartOverview Implementation

## Question 1: How is X-Axis Set to Show All Data in the Circular Buffer?

### Current Implementation

**Short Answer:** The X-axis does **NOT** automatically show all data in the circular buffer. Instead, it uses a **sliding 2-minute window** in live mode that tracks the latest data.

### Detailed Explanation

#### 1. **Live Mode (Auto-Scroll)**

In live mode, the X-axis uses a **fixed 2-minute window** that automatically scrolls to show the latest data:

```typescript
// From MultiPaneChart.tsx, line ~3351
const windowMs = 2 * 60 * 1000; // 2 minutes - small window to focus on latest data

// Get actual data range from DataSeries
let actualDataMax = 0;
for (const [seriesId, entry] of refs.dataSeriesStore) {
  if (entry.dataSeries.count() > 0) {
    const xRange = entry.dataSeries.getXRange();
    if (xRange && isFinite(xRange.max) && xRange.max > 0) {
      if (!hasActualData || xRange.max > actualDataMax) {
        actualDataMax = xRange.max; // Latest data point
      }
    }
  }
}

// Create 2-minute window ending at latest data
const padding = 10 * 1000; // 10 seconds padding
const newRange = new NumberRange(
  scrollTarget - windowMs,  // Start: 2 minutes before latest
  scrollTarget + padding     // End: 10 seconds after latest
);

// Update X-axis
xAxis.visibleRange = newRange;
```

**Characteristics:**
- ✅ **Sliding window** - Always shows latest 2 minutes
- ✅ **Auto-scrolls** - Automatically updates as new data arrives
- ❌ **Does NOT show all data** - Only shows 2-minute window
- ❌ **Older data not visible** - Data older than 2 minutes is in buffer but not displayed

#### 2. **FIFO Circular Buffer**

The DataSeries uses FIFO (First-In-First-Out) mode to maintain a circular buffer:

```typescript
// From MultiPaneChart.tsx, line ~529
new XyDataSeries(wasmContext, {
  fifoCapacity: config.performance.fifoEnabled ? capacity : undefined,
  capacity: capacity,  // e.g., 50,000-100,000 points
  containsNaN: false,
  dataIsSortedInX: true,
  dataEvenlySpacedInX: true,
});
```

**FIFO Behavior:**
- ✅ **Automatic cleanup** - Old data automatically discarded when buffer is full
- ✅ **Constant memory** - Memory usage stays constant (doesn't grow)
- ✅ **Data retention** - Holds up to `fifoCapacity` points (e.g., 50,000-100,000)
- ❌ **Data loss** - Data beyond `fifoCapacity` is permanently discarded

**Example:**
```
FIFO Capacity: 50,000 points
Data Rate: 40 ticks/sec
Time Window: 50,000 / 40 = 1,250 seconds ≈ 20.8 minutes

So the buffer holds ~20 minutes of data, but X-axis only shows 2 minutes.
```

#### 3. **How to Show ALL Data in Buffer**

To show **all data** currently in the circular buffer, you need to:

**Option A: Use `zoomExtents()`**
```typescript
// Zoom to show all data in all series
surface.zoomExtents();

// Or zoom only X-axis
surface.zoomExtentsX();
```

**Option B: Manually Set Range to Full Data Range**
```typescript
// Get full data range from DataSeries
let dataMin = Infinity;
let dataMax = -Infinity;

for (const [seriesId, entry] of refs.dataSeriesStore) {
  if (entry.dataSeries.count() > 0) {
    const xRange = entry.dataSeries.getXRange();
    if (xRange && isFinite(xRange.min) && isFinite(xRange.max)) {
      dataMin = Math.min(dataMin, xRange.min);
      dataMax = Math.max(dataMax, xRange.max);
    }
  }
}

// Set X-axis to show all data
if (isFinite(dataMin) && isFinite(dataMax)) {
  const padding = (dataMax - dataMin) * 0.05; // 5% padding
  xAxis.visibleRange = new NumberRange(
    dataMin - padding,
    dataMax + padding
  );
}
```

**Option C: Use ZoomExtentsModifier (Double-Click)**
- The `ZoomExtentsModifier` is already added to all surfaces
- **Double-click** on the chart to zoom to show all data
- This calls `surface.zoomExtents()` automatically

### Current Behavior Summary

| Mode | X-Axis Range | Shows All Buffer? |
|------|--------------|-------------------|
| **Live (Auto-Scroll)** | 2-minute sliding window | ❌ No - only latest 2 minutes |
| **Paused** | User-controlled (can zoom/pan) | ⚠️ Depends on user interaction |
| **Double-Click** | All data (via ZoomExtentsModifier) | ✅ Yes - shows all data in buffer |
| **Manual Zoom** | User-controlled | ⚠️ Depends on user zoom level |

### Why 2-Minute Window?

The 2-minute window is chosen for:
1. **Performance** - Smaller window = faster rendering
2. **Focus** - Shows most recent/relevant data
3. **Usability** - Easier to see recent price movements
4. **Memory** - FIFO buffer can hold ~20 minutes, but showing all would be slow

### Configuration

The window size is **hardcoded** in the auto-scroll logic:
```typescript
const windowMs = 2 * 60 * 1000; // 2 minutes
```

To change it, modify `MultiPaneChart.tsx` line ~3351.

---

## Question 2: Does SciChartOverview Work?

### Short Answer

**Yes, SciChartOverview is fully implemented and working.**

### Implementation Details

#### 1. **Overview Creation**

The overview is created from a source surface and shares DataSeries with the main chart:

```typescript
// From MultiPaneChart.tsx, line ~1215
const overview = await SciChartOverview.create(sourceSurface, overviewContainerId, {
  theme: chartTheme,
});

refs.overview = overview;
```

**Source Surface Selection:**
- If `plotLayout.minimapSourceSeries` is specified, uses the surface containing that series
- Otherwise, uses the first available surface (tick surface or first dynamic pane)

#### 2. **Overview Behavior**

**Automatic Features:**
- ✅ **Shows all series** - Automatically displays all series on the source surface
- ✅ **Shares DataSeries** - Uses the same DataSeries as main chart (no duplication)
- ✅ **Synchronized** - Overview window syncs with main chart's visible range
- ✅ **Interactive** - Can drag the overview window to navigate main chart

**Overview Window:**
- The overview shows a **highlighted window** representing the main chart's visible range
- Dragging the window updates the main chart's X-axis range
- The window automatically updates when main chart auto-scrolls

#### 3. **Live Mode Synchronization**

In live mode, the overview window tracks the main chart's visible range:

```typescript
// From MultiPaneChart.tsx, line ~4689
if (latestTime > 0 && refs.overview && isLiveRef.current && feedStageRef.current === 'live') {
  const overviewSurface = (refs.overview as any).sciChartSurface;
  const overviewXAxis = overviewSurface.xAxes.get(0);
  const mainXAxis = refs.tickSurface?.xAxes.get(0) || ...;
  
  if (mainXAxis && mainXAxis.visibleRange) {
    const mainRange = mainXAxis.visibleRange;
    // Sync overview window to main chart range
    overviewXAxis.visibleRange = new NumberRange(mainRange.min, mainRange.max);
  }
}
```

#### 4. **Visibility Control**

The overview is **always created** but visibility is controlled via CSS:

```typescript
// From TradingChart.tsx, line ~905
<div 
  className={`shrink-0 border-t border-border/60 relative glass-card transition-all duration-200 ${
    minimapEnabled 
      ? 'h-20 opacity-100 overflow-visible' 
      : 'h-0 opacity-0 overflow-hidden pointer-events-none'
  }`}
>
  <div id="overview-chart" className="w-full h-full rounded-b-lg" />
</div>
```

**Toggle:**
- Press **`M`** key to toggle minimap
- Or use toolbar button / command palette
- Overview is **never deleted** - only hidden/shown via CSS

#### 5. **"Waiting for Data" Overlay**

When the minimap source series has no data, a "Waiting for Data" overlay is shown:

```typescript
// From MultiPaneChart.tsx, line ~1224
if (minimapSourceSeriesId) {
  const sourceSeriesEntry = refs.dataSeriesStore.get(minimapSourceSeriesId);
  const hasData = sourceSeriesEntry?.dataSeries && 
    (sourceSeriesEntry.dataSeries.count() > 0 || 
     (sourceSeriesEntry.dataSeries as any).xValues?.length > 0);
  
  const waitingOverlay = document.getElementById('overview-chart-waiting');
  if (waitingOverlay) {
    waitingOverlay.style.display = hasData ? 'none' : 'flex';
  }
}
```

### Overview Features

| Feature | Status | Notes |
|---------|--------|-------|
| **Creation** | ✅ Working | Created from source surface |
| **Data Display** | ✅ Working | Shows all series on source surface |
| **Window Sync** | ✅ Working | Overview window syncs with main chart |
| **Navigation** | ✅ Working | Drag window to navigate main chart |
| **Live Mode** | ✅ Working | Window tracks auto-scroll in live mode |
| **Visibility Toggle** | ✅ Working | Toggle via `M` key or toolbar |
| **Data Sharing** | ✅ Working | Shares DataSeries (no duplication) |

### Known Limitations

1. **Source Series Selection**
   - Overview shows **all series** on the source surface
   - Cannot selectively show only specific series in overview
   - Workaround: Use a surface that only contains the desired series

2. **Overview Window Size**
   - Window size is automatically calculated by SciChartOverview
   - Cannot manually control window size
   - Window represents main chart's visible range

3. **Performance**
   - Overview renders all series, which can impact performance with many series
   - Consider using a surface with fewer series for better performance

### Testing the Overview

**To verify overview is working:**

1. **Enable Minimap:**
   - Press `M` key or click minimap button in toolbar
   - Overview should appear at bottom of chart

2. **Check Data Display:**
   - Overview should show all series from source surface
   - Series should match main chart

3. **Test Navigation:**
   - Drag the overview window left/right
   - Main chart should update to show that range

4. **Test Live Mode:**
   - Enable live mode (auto-scroll)
   - Overview window should track main chart's visible range
   - Window should move right as new data arrives

5. **Test Zoom:**
   - Zoom in/out on main chart
   - Overview window should resize to match visible range

---

## Recommendations

### For Showing All Data in Buffer

**Current Approach (2-minute window):**
- ✅ Good for live trading (focus on recent data)
- ✅ Better performance (smaller rendering window)
- ❌ Doesn't show historical data in buffer

**Alternative Approaches:**

1. **Add "Show All" Button:**
   ```typescript
   const showAllData = () => {
     surface.zoomExtentsX();
   };
   ```

2. **Make Window Size Configurable:**
   ```typescript
   const windowMs = config.chart.xAxisWindowMs || 2 * 60 * 1000;
   ```

3. **Add Time Range Selector:**
   - Dropdown: "2 min", "5 min", "10 min", "All Data"
   - Updates X-axis range accordingly

### For Overview Improvements

**Current Implementation:**
- ✅ Fully functional
- ✅ Properly synchronized
- ✅ Good performance

**Potential Enhancements:**

1. **Custom Overview Series:**
   - Allow selecting which series to show in overview
   - Currently shows all series on source surface

2. **Overview Window Styling:**
   - Customize window appearance (color, opacity)
   - Currently uses SciChartOverview defaults

3. **Overview Position:**
   - Allow top/bottom positioning
   - Currently fixed at bottom

---

## Summary

### X-Axis Range

- **Current:** 2-minute sliding window in live mode
- **Does NOT show all buffer data** automatically
- **To show all:** Use `zoomExtents()` or double-click chart
- **FIFO buffer:** Holds 50K-100K points (~20 minutes), but only 2 minutes visible

### SciChartOverview

- **Status:** ✅ Fully implemented and working
- **Features:** Shows all series, syncs with main chart, interactive navigation
- **Toggle:** Press `M` key or use toolbar button
- **Limitations:** Shows all series on source surface (cannot filter)

---

**Document Version:** 1.0  
**Date:** 2024  
**Author:** Technical Documentation Team


