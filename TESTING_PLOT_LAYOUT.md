# Testing Plot Layout Implementation

## Prerequisites

1. **Start the server**:
   ```bash
   python server.py --mode session --instrument MESU5 --tick-hz 1000 --session-ms 23400000 --sim-speed 1500 --total-samples 0 --indicator-windows "10,20,30,40,50,60,70,80,90" --bar-intervals 3600000 --strategy-rate-per-min 0 --ring-capacity 12000000 --history-chunk 8192 --live-batch 4096
   ```

2. **Start the UI**:
   ```bash
   npm run dev
   ```

3. **Open browser**: Navigate to `http://localhost:8080`

---

## Test Cases

### Test 1: Default Layout (Cold Start)

**What to Test**: UI should load default layout from `ui-config.json`

**Steps**:
1. Open the browser console (F12)
2. Look for log: `[TradingChart] Loaded default layout from UI config: [2,1]`
3. Verify the chart shows 2 panes (Tick Price & Indicators, OHLC Candlesticks)

**Expected Result**: 
- ✅ Default layout loads automatically
- ✅ Chart displays with 2 panes
- ✅ Series are routed correctly

---

### Test 2: Load Simple 2x1 Layout

**What to Test**: Load a basic 2x1 layout JSON file

**Steps**:
1. Click "Load Layout" button in the toolbar (or use Ctrl/Cmd+K → "Load Layout")
2. Select `layout-2x1-simple.json`
3. Check console for: `[TradingChart] Layout file loaded: ...`
4. Verify chart updates

**Expected Result**:
- ✅ Layout loads without errors
- ✅ Chart shows 2 panes
- ✅ Series are assigned to correct panes

---

### Test 3: Load 2x2 Grid Layout

**What to Test**: Dynamic grid with 4 panes

**Steps**:
1. Load `layout-2x2-grid.json`
2. Check console for grid dimensions: `grid: [2,2]`
3. **Note**: Currently this will still show 2 panes (bridge implementation)
4. Check console for series assignments

**Expected Result**:
- ✅ Layout parses correctly
- ✅ Series-to-pane mapping works
- ⚠️ UI still shows 2 panes (dynamic grid not yet implemented)

---

### Test 4: Layout with PnL Pane

**What to Test**: Dedicated PnL plot

**Steps**:
1. Load `layout-with-pnl.json`
2. Check console for PnL pane assignment
3. Verify PnL series routes to PnL pane (currently routes to tick chart)

**Expected Result**:
- ✅ Layout parses correctly
- ✅ PnL pane is defined in layout
- ⚠️ PnL still routes to tick chart (dedicated pane not yet implemented)

---

### Test 5: Layout with Overlays (Hlines/Vlines)

**What to Test**: Horizontal and vertical line overlays

**Steps**:
1. Load `layout-with-overlays.json`
2. Check console for overlay configuration
3. **Note**: Overlays are not yet rendered

**Expected Result**:
- ✅ Layout parses correctly
- ✅ Overlays are defined in layout
- ⚠️ Overlays not yet rendered (feature not implemented)

---

### Test 6: Strategy Markers Routing

**What to Test**: Strategy markers should go to all plots except PnL and bar plots

**Steps**:
1. Load `layout-strategy-markers.json`
2. Check console for: `strategyMarkerPanes: Set(...)`
3. Verify which panes should show markers

**Expected Result**:
- ✅ Layout parses correctly
- ✅ Strategy marker panes are determined
- ⚠️ Markers not yet rendered on multiple panes

---

### Test 7: Mid-Run Layout Loading

**What to Test**: Load a new layout while data is streaming

**Steps**:
1. Wait for data to start streaming (Status: LIVE)
2. Load a different layout (e.g., switch from 2x1 to 2x2)
3. Check console for layout change
4. Verify data continues streaming
5. **Note**: Series won't move between panes yet (feature not implemented)

**Expected Result**:
- ✅ Layout loads without errors
- ✅ Data continues streaming
- ⚠️ Series don't move between panes (feature not implemented)

---

### Test 8: Invalid Layout Handling

**What to Test**: Error handling for invalid JSON

**Steps**:
1. Create an invalid JSON file (missing required fields)
2. Try to load it
3. Check for error message

**Expected Result**:
- ✅ Error is caught and displayed
- ✅ UI doesn't crash
- ✅ Previous layout remains active

---

## Console Logs to Watch For

### Successful Layout Load:
```
[TradingChart] Layout file loaded: {layout_mode: "multi_surface", grid: [2, 1], ...}
[TradingChart] Applied layout: X series activated, grid: 2x1
[PlotLayoutManager] Layout loaded: {grid: [2, 1], panes: 2, series: X, ...}
[MultiPaneChart] Created DataSeries on-demand for ... on tick-pane chart ...
```

### Layout Parsing Errors:
```
[PlotLayoutManager] Failed to parse layout: Error: Invalid grid: must be [rows, cols] array
[TradingChart] Failed to load layout: ...
```

### Series Routing:
```
[MultiPaneChart] Created DataSeries on-demand for MESU5:ticks (tick) on tick-pane chart ...
[MultiPaneChart] Created DataSeries on-demand for MESU5:ohlc_time:10000 (ohlc-bar) on ohlc-pane chart ...
```

---

## Current Limitations (Expected Behavior)

1. **Dynamic Grid**: Layouts with grid sizes other than 2x1 will parse correctly but still show 2 panes
2. **PnL Pane**: PnL will route to tick chart, not a dedicated pane
3. **Overlays**: Hlines/Vlines are defined but not rendered
4. **Strategy Markers**: Routing is determined but markers aren't rendered on multiple panes
5. **Mid-Run Changes**: Layout can be loaded but series won't move between panes

---

## Debugging Tips

1. **Check Console**: All layout operations log to console with `[PlotLayoutManager]` or `[TradingChart]` prefix
2. **Inspect Layout State**: In browser console, check `plotLayout` state in React DevTools
3. **Verify Series Assignment**: Check `dataSeriesStore` in `MultiPaneChart` to see which pane each series is assigned to
4. **Check Registry**: Verify that series IDs in layout match series IDs in the data registry

---

## Next Steps After Testing

Once you've verified the current implementation works:

1. **Report Issues**: Note any parsing errors, routing issues, or unexpected behavior
2. **Request Features**: If you need specific features (dynamic grid, overlays, etc.), we can prioritize implementation
3. **Provide Feedback**: Let me know which layouts work and which don't




