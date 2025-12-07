# Test Cases for Data Ingestion Pipeline Refactoring

## Overview
This document provides test cases to verify that the unified DataSeries store and registry-based preallocation are working correctly.

---

## ✅ **Test Case 1: UI Config Loading**

### **Objective:** Verify UI config is loaded correctly with new structure

### **Steps:**
1. Open browser DevTools Console
2. Load the application
3. Check console for any config loading errors

### **Expected Results:**
- ✅ No errors in console
- ✅ Config loaded with `data.buffers.pointsPerSeries: 1000000`
- ✅ Config loaded with `data.buffers.maxPointsTotal: 10000000`
- ✅ Config loaded with `chart.timezone: "UTC"`

### **How to Verify:**
```javascript
// In browser console, check:
console.log('Config loaded:', window.uiConfig); // If exposed
// Or check Network tab for ui-config.json request (200 OK)
```

---

## ✅ **Test Case 2: Registry-Based Preallocation**

### **Objective:** Verify DataSeries are preallocated when series are discovered in registry

### **Steps:**
1. Start the server with sine wave data:
   ```bash
   python server.py --mode session --instrument MESU5 --tick-hz 1000 --session-ms 23400000 --sim-speed 1500 --total-samples 0 --indicator-windows "10,20,30" --bar-intervals 3600000
   ```
2. Open browser DevTools Console
3. Watch for preallocation logs

### **Expected Results:**
- ✅ Console shows: `[MultiPaneChart] Preallocated DataSeries for ES.c.0:ticks (tick) on tick chart with capacity 1000000`
- ✅ Console shows: `[MultiPaneChart] Preallocated DataSeries for ES.c.0:sma_10 (tick-indicator) on tick chart with capacity 1000000`
- ✅ Console shows: `[MultiPaneChart] Preallocated DataSeries for ES.c.0:ohlc_time:3600000 (ohlc-bar) on ohlc chart with capacity 1000000`
- ✅ All series appear in `dataSeriesStore` before data arrives

### **How to Verify:**
```javascript
// In browser console after connection:
// Check that series are preallocated
// Look for console logs with "Preallocated DataSeries"
```

### **Failure Indicators:**
- ❌ No preallocation logs
- ❌ Series created on-demand when data arrives (old behavior)
- ❌ Console errors about missing DataSeries

---

## ✅ **Test Case 3: Unified Store Data Ingestion**

### **Objective:** Verify all series types use unified store for data ingestion

### **Steps:**
1. Start server with multiple series types (tick, OHLC, indicators)
2. Monitor browser console
3. Check that data is appended to preallocated series

### **Expected Results:**
- ✅ No errors about missing `tickDataSeries` or `ohlcDataSeries`
- ✅ Data appended to series in unified store
- ✅ All series types (tick, OHLC, indicators) receive data
- ✅ Console shows data being appended (if logging enabled)

### **How to Verify:**
```javascript
// In browser console:
// Check that dataSeriesStore has entries
// Verify no errors about "Series not found in dataSeriesStore"
```

### **Failure Indicators:**
- ❌ Errors: "Series not found in dataSeriesStore"
- ❌ Data not appearing on chart
- ❌ References to old `tickDataSeries` or `ohlcDataSeries` variables

---

## ✅ **Test Case 4: Dynamic Series Discovery**

### **Objective:** Verify new series are discovered and preallocated dynamically

### **Steps:**
1. Start server with initial series (e.g., just ticks)
2. Wait for chart to load
3. Server adds new series (e.g., indicators) after 10 seconds
4. Monitor console for preallocation logs

### **Expected Results:**
- ✅ New series preallocated when discovered
- ✅ New series appear on chart without refresh
- ✅ No errors about missing series

### **How to Verify:**
- Watch console for new preallocation logs
- Check that new series appear in Series Browser
- Verify new series plot data correctly

---

## ✅ **Test Case 5: Preallocation Capacity**

### **Objective:** Verify preallocation uses correct capacity from UI config

### **Steps:**
1. Modify `public/ui-config.json`:
   ```json
   {
     "data": {
       "buffers": {
         "pointsPerSeries": 2000000
       }
     }
   }
   ```
2. Reload application
3. Check preallocation logs

### **Expected Results:**
- ✅ Preallocation logs show capacity: `2000000`
- ✅ DataSeries created with `fifoCapacity: 2000000`
- ✅ No buffer resizing errors

### **How to Verify:**
```javascript
// Check console logs:
// "[MultiPaneChart] Preallocated DataSeries for ... with capacity 2000000"
```

---

## ✅ **Test Case 6: All Series Types**

### **Objective:** Verify all series types are handled correctly

### **Test Series Types:**
1. **Tick series:** `ES.c.0:ticks`
2. **Tick indicator:** `ES.c.0:sma_10`
3. **OHLC bar:** `ES.c.0:ohlc_time:3600000`
4. **Bar indicator:** `ES.c.0:ohlc_time:3600000:rsi`
5. **Strategy PnL:** `ES.c.0:strategy:alpha:pnl`
6. **Strategy marker:** `ES.c.0:strategy:alpha:markers`

### **Steps:**
1. Start server with all series types
2. Verify each type is preallocated
3. Verify each type receives data
4. Verify each type appears on correct chart (tick vs OHLC)

### **Expected Results:**
- ✅ Tick series → tick chart
- ✅ Tick indicators → tick chart
- ✅ OHLC bars → OHLC chart
- ✅ Bar indicators → OHLC chart
- ✅ Strategy series → tick chart (typically)

### **How to Verify:**
- Check preallocation logs for each series type
- Verify series appear on correct chart surface
- Check Series Browser shows correct chart assignment

---

## ✅ **Test Case 7: Data Processing Performance**

### **Objective:** Verify unified store doesn't degrade performance

### **Steps:**
1. Start server with high data rate (20k samples/sec)
2. Monitor FPS in HUD
3. Check CPU usage
4. Verify no memory leaks

### **Expected Results:**
- ✅ FPS: 50-60 FPS (or similar to before)
- ✅ CPU: < 80% (should be similar to before)
- ✅ No memory leaks (memory stable over time)
- ✅ Smooth chart rendering

### **How to Verify:**
- Check HUD for FPS/CPU metrics
- Monitor browser DevTools Performance tab
- Check Memory tab for leaks

---

## ✅ **Test Case 8: Series Visibility Toggle**

### **Objective:** Verify series visibility works with unified store

### **Steps:**
1. Load chart with multiple series
2. Toggle series visibility in Series Browser
3. Verify chart updates immediately

### **Expected Results:**
- ✅ Series visibility toggles work
- ✅ Chart updates immediately (no delay)
- ✅ All series in unified store respect visibility state

### **How to Verify:**
- Toggle series on/off in Series Browser
- Verify chart updates instantly
- Check console for no errors

---

## ✅ **Test Case 9: Error Handling**

### **Objective:** Verify error handling for missing series

### **Steps:**
1. Manually send data for a series that wasn't preallocated
2. Monitor console for warnings

### **Expected Results:**
- ✅ Warning logged: `Series not found in dataSeriesStore - skipping append`
- ✅ Application continues running (no crash)
- ✅ Other series continue working

### **How to Verify:**
- Check console for warning messages
- Verify application doesn't crash
- Verify other series still work

---

## ✅ **Test Case 10: Legacy Config Support**

### **Objective:** Verify old config structure still works

### **Steps:**
1. Modify `public/ui-config.json` to use old structure:
   ```json
   {
     "dataBuffers": {
       "preallocatedPointsPerSeries": 500000
     }
   }
   ```
2. Reload application
3. Verify preallocation uses 500000

### **Expected Results:**
- ✅ Old config structure is recognized
- ✅ Preallocation uses legacy value (500000)
- ✅ No errors about missing config

### **How to Verify:**
- Check preallocation logs show capacity: 500000
- Verify application works normally

---

## 🔍 **Debugging Tips**

### **Check Unified Store:**
```javascript
// In browser console (if exposed):
console.log('DataSeries Store:', chartRefs.current.dataSeriesStore);
console.log('Store size:', chartRefs.current.dataSeriesStore.size);
```

### **Check Registry:**
```javascript
// In browser console:
// Registry should be visible in Series Browser or HUD
```

### **Check Preallocation:**
- Look for console logs: `[MultiPaneChart] Preallocated DataSeries for ...`
- Verify logs appear BEFORE data arrives
- Check capacity matches UI config

### **Check Data Ingestion:**
- Look for console warnings: `Series not found in dataSeriesStore`
- Verify no errors about missing `tickDataSeries` or `ohlcDataSeries`
- Check that data appears on charts

---

## 📋 **Test Checklist**

Before marking as complete, verify:

- [ ] UI config loads correctly
- [ ] Registry preallocation works for all series types
- [ ] Unified store is used for all data ingestion
- [ ] No hardcoded series creation (except maybe initial setup)
- [ ] All series types (tick, OHLC, indicators, strategy) work
- [ ] Dynamic series discovery works
- [ ] Preallocation capacity matches UI config
- [ ] Performance is maintained (FPS, CPU)
- [ ] Series visibility toggle works
- [ ] Error handling works (missing series)
- [ ] Legacy config support works

---

## 🚨 **Known Issues / Limitations**

- Initial tick/OHLC series might still be created during chart initialization (if needed for immediate rendering)
- Registry preallocation depends on `isReady` flag - ensure this is set correctly
- Some series might arrive before registry is populated (should be handled gracefully)

---

## 📝 **Notes**

- Test with different server configurations (sine wave, random walk, real data)
- Test with different data rates (low, medium, high)
- Test with different series counts (1, 5, 10, 20+ series)
- Test tab visibility behavior (minimize/restore)
- Test with paused/live modes




