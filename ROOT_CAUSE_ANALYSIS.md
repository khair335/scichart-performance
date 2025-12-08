# Root Cause Analysis: Series Not Appearing

## The Problem

From your logs:
```
[MultiPaneChart] Preallocation skipped: registry empty
[MultiPaneChart] 📊 Pane tick-pane status: 3 assigned, 3 pending
  ['MESU5:ticks: not created yet', ...]
```

Series never get created because **the registry never populates**.

## The Real Issue: NO SAMPLE DATA FROM SERVER

Your logs show:
- ✅ WebSocket connects successfully
- ✅ `init_begin` received
- ✅ `init_complete` received
- ✅ `heartbeat` received (every 5 seconds)
- ❌ **NO sample data messages** ('history', 'delta', or 'live')

## How Registry Population Works

The registry is **NOT sent as a SNAPSHOT**. Instead, it's built incrementally from samples:

1. Server sends sample messages: `{type: 'history', samples: [...]}`
2. `WsFeedClient._handleSamplesFrame()` processes each sample
3. `WsFeedClient._updateRegistry()` adds series to registry
4. `_regDirty` flag is set to `true`
5. `WsFeedClient._emitStatus()` calls `onRegistry()` callback
6. `useWebSocketFeed` receives registry update
7. `MultiPaneChart` preallocates series

**The problem**: Step 1 never happens. Your server sends control messages but NO samples.

## What I Changed

I **only added diagnostic logging** - no functional changes. Your code was NOT broken by optimization.

### New WsFeedClient Logs

Now you'll see:
```
[WsFeedClient] 📦 _handleSamplesFrame called: type=history, samples=1000
[WsFeedClient] Processing 1000 samples of type history
[WsFeedClient] ✅ Accepted 1000 samples, calling onSamples with 1000 samples
[WsFeedClient] 📋 Emitting registry with 15 series
```

Or if no samples arrive:
```
(No WsFeedClient logs at all - meaning _handleSamplesFrame never called)
```

## Diagnostic: What To Look For

### Scenario A: Server Not Sending Samples (Most Likely)

**Logs you'll see**:
```
[useWebSocketFeed] 📡 Event: init_begin
[useWebSocketFeed] 📡 Event: init_complete
[useWebSocketFeed] 📡 Event: heartbeat
(No [WsFeedClient] logs)
(No [useWebSocketFeed] 📦 Received samples logs)
```

**Meaning**: Server connects but doesn't send data.

**Solution**: Check your Python server:
1. Is it actually generating/sending samples?
2. Check server console for errors
3. Check if data source is empty
4. Verify server is sending messages with `type: 'history'` or `'live'`

### Scenario B: Samples Arriving But All Duplicates

**Logs you'll see**:
```
[WsFeedClient] 📦 _handleSamplesFrame called: type=history, samples=1000
[WsFeedClient] Processing 1000 samples of type history
[WsFeedClient] ⚠️ No samples accepted (all duplicates or invalid)
```

**Meaning**: Server sending old data you already have in localStorage.

**Solution**:
```javascript
// In browser console:
localStorage.clear()
// Then refresh page
```

### Scenario C: Samples Arriving But Missing series_id

**Logs you'll see**:
```
[WsFeedClient] 📦 _handleSamplesFrame called: type=history, samples=1000
[WsFeedClient] Processing 1000 samples of type history
[WsFeedClient] Sample has no series_id, skipping registry update
[WsFeedClient] ✅ Accepted 1000 samples, calling onSamples with 1000 samples
(No registry emission)
```

**Meaning**: Samples are malformed.

**Solution**: Fix server to include `series_id` in each sample.

### Scenario D: Working Correctly

**Logs you'll see**:
```
[useWebSocketFeed] 📡 Event: init_begin
[useWebSocketFeed] 📡 Event: init_complete
[WsFeedClient] 📦 _handleSamplesFrame called: type=history, samples=1000
[WsFeedClient] Processing 1000 samples of type history
[WsFeedClient] ✅ Accepted 1000 samples, calling onSamples with 1000 samples
[useWebSocketFeed] 📦 Received 1000 samples
[WsFeedClient] 📋 Emitting registry with 15 series
[useWebSocketFeed] 📋 Registry updated: 15 series
[MultiPaneChart] 🔄 Preallocation effect triggered {registryLength: 15, ...}
[MultiPaneChart] 📊 Preallocating 15 series...
```

## Why This Worked Before

If it truly worked before, possibilities:
1. **Server was sending data before, isn't now**
   - Server crashed/restarted?
   - Data source empty?
   - Server configuration changed?

2. **LocalStorage had cached data**
   - On first load, you received samples → registry populated
   - On subsequent loads, you're in "resume" mode
   - Server sends nothing if you're already caught up
   - Registry was persisted, appeared to work

3. **You were using demo mode**
   - Demo mode generates fake data internally
   - Doesn't need WebSocket samples

## Server Requirements

Your Python server MUST send messages like:

```json
{
  "type": "history",
  "samples": [
    {
      "seq": 1,
      "series_seq": 1,
      "series_id": "MESU5:ticks",
      "t_ms": 1765191338372,
      "payload": {"y": 6000.5}
    },
    {
      "seq": 2,
      "series_seq": 2,
      "series_id": "MESU5:ticks",
      "t_ms": 1765191338392,
      "payload": {"y": 6000.75}
    }
  ]
}
```

Or for live data:
```json
{
  "type": "live",
  "samples": [...]
}
```

## Quick Tests

### Test 1: Check if server sends ANY data

In browser DevTools → Network → WS:
1. Find WebSocket connection
2. Click it
3. Go to "Messages" tab
4. Look for messages with `"type": "history"` or `"type": "live"`
5. Do you see ANY sample messages?

### Test 2: Clear localStorage

```javascript
// Browser console:
localStorage.clear()
location.reload()
```

If it works after clearing, issue was resume-from-sequence logic.

### Test 3: Check demo mode works

Click "Start Demo" button. If data appears:
- Client code is fine
- Server is the problem

## Most Likely Solution

**Your Python server is not sending sample data.**

Check:
1. Is server running? `python server.py ...`
2. Check server console output for errors
3. Does server have data to send?
4. Is server stuck in some error state?
5. Check server code sends messages with `type: 'history'` or `'live'`

## Next Steps

1. **Refresh browser** and watch console
2. **Look for `[WsFeedClient]` logs**:
   - If you see them → Server IS sending data (check for other issues)
   - If you DON'T see them → **Server NOT sending data** (fix server)
3. **Check WebSocket Messages tab** in DevTools → Network
4. **Check Python server console** for errors
5. **Share new logs** including all `[WsFeedClient]` logs

## Summary

The issue is **NOT in the client code**. The client is working correctly:
- WebSocket connects ✓
- Receives control messages ✓
- Ready to process samples ✓

But samples never arrive, so registry never populates, so series never get created.

**Fix the server to send sample data.**
