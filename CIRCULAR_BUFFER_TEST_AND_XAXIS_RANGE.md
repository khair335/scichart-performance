# Circular Buffer Test & Default X-Axis Range Implementation

## Summary

This document describes:
1. **Circular Buffer Test**: Changed capacity from 1,000,000 to 1,000 to test FIFO behavior
2. **Default X-Axis Range**: Added support for specifying default X-axis range in Plot Layout JSON

---

## 1. Circular Buffer Test

### Changes Made

**File:** `public/ui-config.json`

Changed the buffer capacity from 500,000 to 1,000 points:

```json
{
  "data": {
    "buffers": {
      "pointsPerSeries": 1000,  // Changed from 500000 to 1000
      "maxPointsTotal": 10000000
    }
  }
}
```

### What This Tests

With a capacity of **1,000 points**:
- **Data Rate**: 40 ticks/sec (from server config)
- **Time Window**: 1,000 / 40 = **25 seconds** of data
- **FIFO Behavior**: After 25 seconds, oldest data will be automatically discarded
- **Memory**: Constant memory usage (doesn't grow beyond 1,000 points)

### Expected Behavior

✅ **Should Work:**
- Chart should display data normally
- After 25 seconds, oldest data automatically removed
- No crashes or errors
- Memory usage stays constant

❌ **Potential Issues:**
- If data rate is higher than expected, buffer may fill faster
- If user zooms to see older data, it may not be available (discarded)
- Overview/minimap may show less historical data

### Testing Steps

1. **Start the server:**
   ```bash
   python server.py --mode session --tick-hz 40 --session-ms 23400000
   ```

2. **Run the application** and observe:
   - Chart displays data normally
   - After ~25 seconds, oldest data disappears (FIFO cleanup)
   - No crashes or errors in console
   - Memory usage stays constant

3. **Test edge cases:**
   - Zoom to see older data (should show "no data" if beyond 25 seconds)
   - Pause and resume (should continue working)
   - Switch tabs (background processing should continue)

### Reverting the Test

To revert back to the original capacity:

```json
{
  "data": {
    "buffers": {
      "pointsPerSeries": 500000,  // Restore original value
      "maxPointsTotal": 10000000
    }
  }
}
```

---

## 2. Default X-Axis Range in Plot Layout JSON

### Implementation

Added support for specifying default X-axis range in the Plot Layout JSON file.

### Type Definition

**File:** `src/types/plot-layout.ts`

```typescript
export interface PlotLayout {
  // ... existing fields ...
  xAxis?: {
    defaultRange?: {
      mode: 'lastMinutes' | 'lastHours' | 'entireSession' | 'custom';
      value?: number; // Minutes or hours depending on mode
      customRange?: [number, number]; // [min, max] in milliseconds (Unix timestamp)
    };
  };
}
```

### Supported Modes

#### 1. `lastMinutes`
Show the last N minutes of data.

**Example:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "lastMinutes",
      "value": 30
    }
  }
}
```
Shows the last 30 minutes of data.

#### 2. `lastHours`
Show the last N hours of data.

**Example:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "lastHours",
      "value": 2
    }
  }
}
```
Shows the last 2 hours of data.

#### 3. `entireSession`
Show all data in the circular buffer (entire session).

**Example:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "entireSession"
    }
  }
}
```
Shows all available data (from `dataMin` to `dataMax` with 5% padding).

#### 4. `custom`
Show a custom time range specified in milliseconds (Unix timestamp).

**Example:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "custom",
      "customRange": [1704067200000, 1704070800000]
    }
  }
}
```
Shows data from `1704067200000` (Jan 1, 2024 00:00:00 UTC) to `1704070800000` (Jan 1, 2024 01:00:00 UTC).

### Complete Example

**File:** `public/layouts/example-layout.json`

```json
{
  "layout_mode": "multi_surface",
  "grid": [2, 1],
  "panes": [
    {
      "id": "tick-pane",
      "row": 0,
      "col": 0,
      "height": 1,
      "width": 1,
      "title": "Tick Price & Indicators"
    },
    {
      "id": "ohlc-pane",
      "row": 1,
      "col": 0,
      "height": 1,
      "width": 1,
      "title": "OHLC Candlesticks"
    }
  ],
  "series": [
    {
      "series_id": "MESU5:ticks",
      "pane": "tick-pane",
      "type": "FastLineRenderableSeries"
    }
  ],
  "xAxis": {
    "defaultRange": {
      "mode": "lastMinutes",
      "value": 30
    }
  },
  "minimap": {
    "source": {
      "series_id": "MESU5:ticks",
      "yField": "price"
    }
  }
}
```

### Implementation Details

**File:** `src/components/chart/MultiPaneChart.tsx`

1. **Helper Function:**
   ```typescript
   const calculateDefaultXAxisRange = (
     defaultRange: PlotLayout['xAxis']['defaultRange'],
     latestTime: number,
     dataMin?: number,
     dataMax?: number
   ): NumberRange | null
   ```

2. **Applied When:**
   - Transitioning to live mode
   - Layout is loaded
   - X-axis range is not already set

3. **Priority:**
   - If `xAxis.defaultRange` is specified in layout, it takes precedence
   - Otherwise, falls back to default 2-minute window

### Behavior

- **Live Mode**: Default range is applied when transitioning to live
- **Paused Mode**: Default range can be applied when layout is loaded
- **User Interaction**: If user manually zooms/pans, their range is preserved
- **Auto-Scroll**: In live mode, if default range is set, it's used instead of 2-minute window

---

## 3. Testing the Default X-Axis Range

### Test Case 1: Last 30 Minutes

**Layout JSON:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "lastMinutes",
      "value": 30
    }
  }
}
```

**Expected:**
- X-axis shows last 30 minutes of data
- Range updates as new data arrives (in live mode)
- User can still zoom/pan to other ranges

### Test Case 2: Entire Session

**Layout JSON:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "entireSession"
    }
  }
}
```

**Expected:**
- X-axis shows all data in the circular buffer
- Range spans from earliest to latest data point
- With 1,000 point buffer: shows ~25 seconds of data
- With 500,000 point buffer: shows ~3.5 hours of data (at 40 ticks/sec)

### Test Case 3: Custom Range

**Layout JSON:**
```json
{
  "xAxis": {
    "defaultRange": {
      "mode": "custom",
      "customRange": [1704067200000, 1704070800000]
    }
  }
}
```

**Expected:**
- X-axis shows data from specified timestamps
- If data doesn't exist in that range, shows empty chart
- User can zoom/pan to see other ranges

---

## 4. Files Modified

1. **`public/ui-config.json`**
   - Changed `pointsPerSeries` from 500000 to 1000

2. **`src/types/plot-layout.ts`**
   - Added `xAxis` field to `PlotLayout` interface
   - Added `xAxisDefaultRange` to `ParsedLayout` interface
   - Updated `parsePlotLayout()` to include `xAxisDefaultRange`

3. **`src/components/chart/MultiPaneChart.tsx`**
   - Added `calculateDefaultXAxisRange()` helper function
   - Updated live transition logic to use default range from layout
   - Integrated default range calculation into X-axis range setting

---

## 5. Notes

### Circular Buffer Test

- **Small buffer (1,000 points)** is useful for testing FIFO behavior
- **Production use** should use larger buffer (50,000-500,000 points)
- **Memory impact**: Smaller buffer = less memory, but less historical data

### Default X-Axis Range

- **Takes precedence** over default 2-minute window
- **Only applied** when transitioning to live or loading layout
- **User interactions** (zoom/pan) override the default range
- **Works with both** legacy surfaces and dynamic panes

---

**Document Version:** 1.0  
**Date:** 2024  
**Author:** Implementation Team


