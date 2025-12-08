# Diagnostic Logging Guide for Waiting Overlay and Series Visibility

## Summary

Added comprehensive diagnostic logging to track:
1. **Registry population** - When WebSocket sends series metadata
2. **Preallocation timing** - When series creation is attempted
3. **Waiting overlay updates** - When overlays show/hide
4. **Series data status** - Which series have data vs. waiting

## New Console Logs to Monitor

### 1. Registry Updates (WebSocket)

```
[useWebSocketFeed] 📋 Registry updated: N series
```

**When it appears**: When WebSocket SNAPSHOT message arrives with series metadata

**What to check**:
- Does this appear AFTER panes are created?
- If yes → timing issue (registry arrives too late)
- If no → WebSocket not connecting

### 2. Preallocation Effect Triggered

```
[MultiPaneChart] 🔄 Preallocation effect triggered {
  registryLength: N,
  isReady: true/false,
  plotLayoutLoaded: true/false,
  paneSurfacesCount: N
}
```

**When it appears**: Every time the preallocation effect runs

**What to check**:
- `registryLength` should be > 0
- `isReady` should be true
- `paneSurfacesCount` should match your layout

**Common issues**:
- `registryLength: 0` → WebSocket hasn't sent SNAPSHOT yet
- `isReady: false` → Chart still initializing
- `paneSurfacesCount: 0` → Panes not created yet

### 3. Waiting Overlay Status

```
[MultiPaneChart] 📊 Pane paneId status: N assigned, M pending [...]
```

**Details shown**:
- Number of series assigned to the pane
- Number of series pending (no data yet)
- Status of each series:
  - `series: N points` - Has data
  - `series: 0 points (waiting)` - Created but no data
  - `series: not created yet` - Not preallocated

**What to check**:
- If all series show "not created yet" → Preallocation failed
- If series show "0 points (waiting)" → Preallocation worked, waiting for data
- If series show "N points" → Data arrived

### 4. Overlay Visibility Changes

```
[MultiPaneChart] 📊 Showing waiting overlay for pane paneId: N series pending
```

or

```
[MultiPaneChart] ✅ Hiding waiting overlay for pane paneId: all series have data
```

**What to check**:
- Overlay should SHOW when series are created but have no data
- Overlay should HIDE when all assigned series have data

### 5. Overlay Not Found Warning

```
[MultiPaneChart] ⚠️ Waiting overlay not found for pane paneId
```

**What this means**:
- The DOM element for the overlay doesn't exist
- Likely a timing issue with pane creation
- Or the pane ID doesn't match

## Testing Workflow

### Step 1: Clear Console and Start Fresh

1. Open DevTools (F12)
2. Clear console (Ctrl+L or Clear button)
3. Refresh page (F5)

### Step 2: Load Your Layout

1. Click toolbar → Load layout
2. Select `layout-mesu5-pnl-waiting.json`
3. Watch console logs

### Step 3: Expected Log Sequence

```
✅ GOOD SEQUENCE (everything working):

1. [TradingChart] Loading default layout from: /layouts/layout-2x1-simple.json
2. [DynamicPlotGrid] Layout changed, resetting notification flag
3. [DynamicPlotGrid] All panes created, notifying parent that grid is ready
4. [MultiPaneChart] Creating pane manager for grid initialization
5. [MultiPaneChart] Creating panes for layout: ['pricePane', 'pnlPane']
6. [MultiPaneChart] Pane created successfully: pricePane
7. [MultiPaneChart] Pane created successfully: pnlPane
8. [MultiPaneChart] 🎯 Initializing waiting overlay for pane: pricePane
9. [MultiPaneChart] 🎯 Initializing waiting overlay for pane: pnlPane
10. [MultiPaneChart] 📊 Pane pricePane status: 2 assigned, 2 pending [...]
11. [MultiPaneChart] 📊 Showing waiting overlay for pane pricePane: 2 series pending
12. [MultiPaneChart] 📊 Pane pnlPane status: 2 assigned, 2 pending [...]
13. [MultiPaneChart] 📊 Showing waiting overlay for pane pnlPane: 2 series pending
14. [useWebSocketFeed] 📋 Registry updated: 15 series
15. [MultiPaneChart] 🔄 Preallocation effect triggered { registryLength: 15, ... }
16. [MultiPaneChart] 📊 Preallocating N new series from registry...
17. [TradingChart] 🔄 Initializing visibleSeries with N series from registry of M
18. (Data starts arriving...)
19. [MultiPaneChart] 📊 Pane pricePane status: 2 assigned, 0 pending [...]
20. [MultiPaneChart] ✅ Hiding waiting overlay for pane pricePane: all series have data
21. [MultiPaneChart] 📊 Pane pnlPane status: 2 assigned, 0 pending [...]
22. [MultiPaneChart] ✅ Hiding waiting overlay for pane pnlPane: all series have data
```

### Step 4: Analyze Your Logs

Compare your actual logs to the expected sequence above.

**Common problems**:

#### Problem A: Registry Arrives Before Panes Created

```
❌ BAD SEQUENCE:
1. [useWebSocketFeed] 📋 Registry updated: 15 series
2. [MultiPaneChart] 🔄 Preallocation effect triggered { registryLength: 15, paneSurfacesCount: 0 }
3. [MultiPaneChart] Preallocation skipped: dynamic panes not created yet
4. (Later...) [MultiPaneChart] Pane created successfully: pricePane
```

**Issue**: Registry populated before panes were ready
**Fix**: Preallocation effect should re-run after panes are created

#### Problem B: Registry Never Arrives

```
❌ BAD SEQUENCE:
1. [MultiPaneChart] Pane created successfully: pricePane
2. [MultiPaneChart] Pane created successfully: pnlPane
3. [MultiPaneChart] 🔄 Preallocation effect triggered { registryLength: 0 }
4. [MultiPaneChart] Preallocation skipped: registry empty
(No registry update log appears)
```

**Issue**: WebSocket not connecting or server not sending SNAPSHOT
**Fix**: Check WebSocket connection, check server logs

#### Problem C: Overlays Not Found

```
❌ BAD SEQUENCE:
1. [MultiPaneChart] Pane created successfully: pricePane
2. [MultiPaneChart] 🎯 Initializing waiting overlay for pane: pricePane
3. [MultiPaneChart] ⚠️ Waiting overlay not found for pane pricePane
```

**Issue**: DOM element `pane-pricePane-waiting` doesn't exist
**Fix**: Check DynamicPlotGrid creates overlay elements

#### Problem D: Series Never Get Data

```
❌ BAD SEQUENCE:
1. [MultiPaneChart] 📊 Showing waiting overlay for pane pricePane: 2 series pending
(Overlay stays visible forever)
```

**Issue**: Data not arriving from WebSocket
**Fix**: Check server is sending sample data, check WebSocket connection

## Files Modified

1. **src/hooks/useWebSocketFeed.ts**
   - Added: Registry update logging

2. **src/components/chart/MultiPaneChart.tsx**
   - Added: Preallocation effect trigger logging
   - Added: Detailed pane status logging
   - Added: Overlay visibility change logging
   - Added: Overlay not found warning

## How to Use These Logs

### For "Waiting Overlay Not Showing" Issue

Look for:
```
[MultiPaneChart] 📊 Showing waiting overlay for pane X: N series pending
```

If you DON'T see this:
1. Check for: `[MultiPaneChart] ⚠️ Waiting overlay not found`
   - If present → DOM element missing
2. Check pane status logs
   - If all series show "not created yet" → Preallocation failed
3. Check preallocation trigger logs
   - Look at `registryLength` value

### For "Series Don't Appear" Issue

Look for:
```
[TradingChart] 🔄 Initializing visibleSeries with N series from registry of M
```

If you DON'T see this:
1. Check for: `[useWebSocketFeed] 📋 Registry updated: N series`
   - If missing → WebSocket issue
2. Check preallocation logs
   - Look at `registryLength` and `isReady` values

### For Performance Issues

The new logs may spam the console. After debugging, you can:
1. Filter console by specific prefixes (e.g., only show errors)
2. Reduce log frequency (edit the code to throttle logs)
3. Remove logs after issue is resolved

## Next Steps

1. **Test with your command**:
   ```bash
   python server.py --mode session --instrument MESU5 ...
   ```

2. **Monitor console logs** and compare to expected sequence

3. **Share the logs** if issue persists:
   - Copy first 50-100 lines of console output
   - Include any error messages
   - Note what you expected vs. what happened

## Temporary Nature

These verbose logs are for DEBUGGING ONLY. Once issues are resolved, we should:
- Remove or reduce log frequency
- Keep only critical warnings/errors
- Possibly add a debug flag to enable verbose logging

For now, they're essential to understand the timing issues with registry population and overlay visibility.
