# WebSocket Connection Debug Guide

## Problem Summary

Your logs show:
1. **Registry NEVER populates** - No `[useWebSocketFeed] 📋 Registry updated` log appears
2. **Series never created** - All series show "not created yet"
3. **Waiting overlays not found** - But they ARE created by DynamicPlotGrid

## What I Added

Enhanced logging to track WebSocket connection lifecycle:

### New Logs to Watch For

```
[useWebSocketFeed] useEffect triggered, autoConnect: true/false
[useWebSocketFeed] 🔌 Attempting to connect to: ws://...
[useWebSocketFeed] Creating new WsFeedClient
[useWebSocketFeed] ✅ Client created, calling connect()
[useWebSocketFeed] 📊 Client stored in ref
[useWebSocketFeed] 📡 Event: <type> <details>
[useWebSocketFeed] 📦 Received N samples
[useWebSocketFeed] 📋 Registry updated: N series
```

## Expected Sequence (Working Connection)

```
✅ GOOD SEQUENCE:

1. [useWebSocketFeed] useEffect triggered, autoConnect: true
2. [useWebSocketFeed] 🔌 Attempting to connect to: ws://localhost:8765
3. [useWebSocketFeed] Creating new WsFeedClient
4. [useWebSocketFeed] ✅ Client created, calling connect()
5. [useWebSocketFeed] 📊 Client stored in ref
6. [useWebSocketFeed] 📡 Event: open {...}
7. [useWebSocketFeed] 📡 Event: message {...}  (SNAPSHOT)
8. [useWebSocketFeed] 📋 Registry updated: 15 series
9. [MultiPaneChart] 🔄 Preallocation effect triggered {registryLength: 15, ...}
10. [MultiPaneChart] 📊 Preallocating 15 series...
11. [useWebSocketFeed] 📦 Received 100 samples
12. (Data starts flowing...)
```

## Diagnostic Steps

### Step 1: Check if WebSocket is Trying to Connect

Look for:
```
[useWebSocketFeed] useEffect triggered, autoConnect: true
[useWebSocketFeed] 🔌 Attempting to connect to: ws://...
```

**If MISSING**:
- autoConnect is false (demo mode active?)
- useWebSocketFeed not being called
- Check TradingChart component initialization

**If shows `autoConnect: false`**:
- You're in demo mode
- Check if "Start Demo" button was clicked
- Demo mode disables WebSocket connection

### Step 2: Check if Client is Created

Look for:
```
[useWebSocketFeed] Creating new WsFeedClient
[useWebSocketFeed] ✅ Client created, calling connect()
```

**If MISSING**:
- Connection attempt failed before client creation
- JavaScript error in WsFeedClient constructor
- Check browser console for errors

### Step 3: Check for Connection Events

Look for:
```
[useWebSocketFeed] 📡 Event: open
```

**If MISSING**:
- WebSocket connection failed
- Server not running
- Wrong URL
- Port blocked/closed

**If shows**:
```
[useWebSocketFeed] 📡 Event: error
[WebSocket Error] <details>
```

- Connection rejected
- Server error
- Check server logs

### Step 4: Check for Registry Update

Look for:
```
[useWebSocketFeed] 📋 Registry updated: N series
```

**If MISSING but connection opened**:
- Server didn't send SNAPSHOT message
- SNAPSHOT parsing failed
- handleRegistry callback not firing
- Check server is sending SNAPSHOT with "registry" field

### Step 5: Check for Sample Data

Look for:
```
[useWebSocketFeed] 📦 Received N samples
```

**If MISSING**:
- Server not sending data
- onSamples callback not firing
- Check server is emitting sample data

## Common Issues

### Issue A: Server Not Running

```
❌ Logs show:
[useWebSocketFeed] 🔌 Attempting to connect to: ws://localhost:8765
(No further logs)
```

**Solution**: Start your Python server
```bash
python server.py --mode session --instrument MESU5
```

### Issue B: Wrong WebSocket URL

Check your `.env` file or config:
```
VITE_WS_URL=ws://localhost:8765
```

Make sure port matches your server.

### Issue C: Demo Mode Active

```
❌ Logs show:
[useWebSocketFeed] useEffect triggered, autoConnect: false
[useWebSocketFeed] AutoConnect is false, skipping connection
```

**Solution**: Don't click "Start Demo" button. WebSocket auto-connects on page load when NOT in demo mode.

### Issue D: Server Doesn't Send SNAPSHOT

```
❌ Logs show:
[useWebSocketFeed] 📡 Event: open
[useWebSocketFeed] 📡 Event: message
(No registry update)
```

**Solution**: Check server sends SNAPSHOT message with structure:
```json
{
  "type": "SNAPSHOT",
  "registry": [
    {"id": "MESU5:ticks", "count": 100, ...},
    ...
  ],
  "samples": [...]
}
```

### Issue E: Waiting Overlay Not Found

Your logs show:
```
[MultiPaneChart] ⚠️ Waiting overlay not found for pane tick-pane
```

This happens because:
1. Panes are created
2. updatePaneWaitingOverlay runs IMMEDIATELY
3. But DOM elements may not be ready yet

The waiting overlay IS created by DynamicPlotGrid (lines 112-130), but timing might be off.

**Check**: Do you see the waiting overlay divs in browser DevTools Elements panel?
- Look for elements with id: `pane-{paneId}-waiting`
- Example: `pane-tick-pane-waiting`, `pane-ohlc-pane-waiting`

## How to Use These Logs

### Test 1: Fresh Page Load

1. **Clear console** (Ctrl+L)
2. **Refresh page** (F5)
3. **Do NOT click anything** (let WebSocket auto-connect)
4. **Copy first 100 lines** of console output
5. **Share logs** with issue description

### Test 2: Check Server

1. Open browser DevTools → Network tab
2. Filter by "WS" (WebSocket)
3. Refresh page
4. Look for WebSocket connection
5. Click on WebSocket connection
6. Check "Messages" tab
7. Do you see SNAPSHOT message?

### Test 3: Check Demo Mode

1. Are you in demo mode?
2. Look for HUD showing "Stage: demo"
3. If yes, refresh page without clicking "Start Demo"

## Server Requirements

Your Python server MUST:

1. **Listen on WebSocket** (default: ws://localhost:8765)
2. **Send SNAPSHOT** on connection with structure:
   ```json
   {
     "type": "SNAPSHOT",
     "registry": [...],
     "samples": [...]
   }
   ```
3. **Send periodic SAMPLES** messages:
   ```json
   {
     "type": "SAMPLES",
     "samples": [...]
   }
   ```

## Next Steps

1. **Run your server**:
   ```bash
   python server.py --mode session --instrument MESU5 --strategy alpha --strategy beta
   ```

2. **Refresh browser** and check console for new logs

3. **Share the logs** showing:
   - WebSocket connection attempt
   - Any events received
   - Any errors

4. **Look for these specific logs**:
   - `[useWebSocketFeed] 🔌 Attempting to connect`
   - `[useWebSocketFeed] 📡 Event: open`
   - `[useWebSocketFeed] 📋 Registry updated`

If you don't see these logs, the problem is with WebSocket connection, not with the chart components.

## Critical Questions

Before debugging further, answer these:

1. **Is your Python server running?**
   - Check terminal for server output
   - Should show "WebSocket server listening on..."

2. **What port is it on?**
   - Default: 8765
   - Match with VITE_WS_URL in .env

3. **Are you in demo mode?**
   - Check HUD top-left corner
   - Should show "Stage: connecting" or "Stage: history", NOT "Stage: demo"

4. **What layout did you actually load?**
   - Your logs show panes: `['top', 'bottom']`
   - But your file has: `['pricePane', 'pnlPane']`
   - Did you load the right file?

## Quick Test

To verify WebSocket connectivity:

1. Open browser DevTools → Console
2. Run this command:
   ```javascript
   new WebSocket('ws://localhost:8765')
   ```
3. If it connects → Server is running
4. If error → Server not running or wrong port

This will help isolate whether the issue is:
- **Server-side**: Server not running or not sending data
- **Client-side**: React component not connecting

Based on your logs, it's almost certainly a **server-side issue** because NO WebSocket connection logs appear at all.
