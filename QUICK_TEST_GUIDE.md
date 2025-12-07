# Quick Test Guide - Plot Layout System

## 🚀 Quick Start

### 1. Start Server
```bash
python server.py --mode session --instrument MESU5 --tick-hz 1000 --session-ms 23400000 --sim-speed 1500 --total-samples 0 --indicator-windows "10,20,30,40,50,60,70,80,90" --bar-intervals 3600000 --strategy-rate-per-min 0 --ring-capacity 12000000 --history-chunk 8192 --live-batch 4096
```

### 2. Start UI
```bash
npm run dev
```

### 3. Open Browser
Navigate to: `http://localhost:8080`

---

## 📋 Test Checklist

### ✅ Test 1: Default Layout (Automatic)
- [ ] Open browser console (F12)
- [ ] Look for: `[TradingChart] Loaded default layout from UI config: [2,1]`
- [ ] Verify chart shows 2 panes
- [ ] Verify data starts plotting

**Expected**: Default layout loads automatically from `ui-config.json`

---

### ✅ Test 2: Load Simple Layout
- [ ] Click "Load Layout" button in toolbar (or Ctrl/Cmd+K → "Load Layout")
- [ ] Select: `public/layouts/layout-2x1-simple.json`
- [ ] Check console for: `[TradingChart] Applied layout: X series activated`
- [ ] Verify chart updates

**Expected**: Layout loads, series are assigned to panes

---

### ✅ Test 3: Load 2x2 Grid
- [ ] Load: `public/layouts/layout-2x2-grid.json`
- [ ] Check console for: `grid: [2,2]`
- [ ] **Note**: UI will still show 2 panes (dynamic grid not yet implemented)

**Expected**: Layout parses correctly, series-to-pane mapping works

---

### ✅ Test 4: Load Layout with PnL
- [ ] Load: `public/layouts/layout-with-pnl.json`
- [ ] Check console for PnL pane assignment
- [ ] **Note**: PnL will route to tick chart (dedicated pane not yet implemented)

**Expected**: Layout parses, PnL pane is defined

---

### ✅ Test 5: Load Layout with Overlays
- [ ] Load: `public/layouts/layout-with-overlays.json`
- [ ] Check console for overlay configuration
- [ ] **Note**: Overlays are not yet rendered

**Expected**: Layout parses, overlays are defined

---

### ✅ Test 6: Strategy Markers Routing
- [ ] Load: `public/layouts/layout-strategy-markers.json`
- [ ] Check console for: `strategyMarkerPanes: Set(...)`
- [ ] Verify which panes should show markers

**Expected**: Strategy marker panes are determined correctly

---

### ✅ Test 7: Invalid Layout Handling
- [ ] Try to load: `public/layouts/layout-invalid-example.json`
- [ ] Check for error message
- [ ] Verify UI doesn't crash

**Expected**: Error is caught and displayed, previous layout remains

---

## 📁 Test Files Location

All test layout files are in: `public/layouts/`

- `layout-2x1-simple.json` - Basic 2x1 layout
- `layout-2x2-grid.json` - 2x2 grid layout
- `layout-with-pnl.json` - Layout with dedicated PnL pane
- `layout-with-overlays.json` - Layout with hlines/vlines
- `layout-strategy-markers.json` - Layout testing strategy markers routing
- `layout-invalid-example.json` - Invalid layout for error testing

---

## 🔍 What to Check in Console

### Successful Load:
```
[TradingChart] Layout file loaded: {layout_mode: "multi_surface", ...}
[PlotLayoutManager] Layout loaded: {grid: [2, 1], panes: 2, series: 4, ...}
[TradingChart] Applied layout: 4 series activated, grid: 2x1
```

### Series Routing:
```
[MultiPaneChart] Created DataSeries on-demand for MESU5:ticks (tick) on tick-pane chart ...
[MultiPaneChart] Created DataSeries on-demand for MESU5:ohlc_time:10000 (ohlc-bar) on ohlc-pane chart ...
```

### Errors:
```
[PlotLayoutManager] Failed to parse layout: Error: Invalid grid: must be [rows, cols] array
[TradingChart] Failed to load layout: ...
```

---

## ⚠️ Current Limitations (Expected)

1. **Dynamic Grid**: Only 2x1 layouts will show correctly (others parse but UI shows 2 panes)
2. **PnL Pane**: PnL routes to tick chart, not dedicated pane
3. **Overlays**: Defined but not rendered
4. **Strategy Markers**: Routing determined but not rendered on multiple panes
5. **Mid-Run Changes**: Layout loads but series don't move between panes

---

## 🐛 Troubleshooting

### Layout doesn't load:
- Check console for errors
- Verify JSON is valid (use JSON validator)
- Check that all required fields are present

### Series not showing:
- Check that series IDs in layout match series IDs in registry
- Check console for series routing logs
- Verify series are in the data registry

### Chart not updating:
- Check that data is streaming (Status: LIVE)
- Verify `visibleSeries` state is updated
- Check console for data append logs

---

## 📝 Notes

- All layout operations log to console with prefixes: `[TradingChart]`, `[PlotLayoutManager]`, `[MultiPaneChart]`
- Use React DevTools to inspect `plotLayout` state
- Check `dataSeriesStore` in `MultiPaneChart` to see series-to-pane assignments




