# Fix: All Samples Rejected as Duplicates

## The Problem

Your logs show:
```
[WsFeedClient] 📦 _handleSamplesFrame called: type=live, samples=537
[WsFeedClient] Processing 537 samples of type live
[WsFeedClient] ⚠️ No samples accepted (all duplicates or invalid)
```

**Server IS sending data** (500+ samples per batch), but **client rejects ALL of them as duplicates**.

## Root Cause

The client stores the last processed sequence number in `localStorage` under key `'feed:last_seq'`. On reconnect, it:

1. Loads `lastSeq` from localStorage (e.g., `880147`)
2. Requests to resume from `lastSeq + 1` (e.g., `880148`)
3. Server sends samples with lower sequence numbers
4. Client rejects them: `if (seq <= this.lastSeq) continue;`

### Why This Happens

**Server restarted** and sequence numbers reset, OR **localStorage has stale data** from a much later session.

## Immediate Fix

### Option 1: Clear localStorage in Browser Console

```javascript
localStorage.clear()
location.reload()
```

### Option 2: Clear Only Feed Data

```javascript
localStorage.removeItem('feed:last_seq')
location.reload()
```

### Option 3: Check Current Value First

```javascript
// See what's stored
console.log('Current lastSeq:', localStorage.getItem('feed:last_seq'))

// If it's a huge number, clear it
localStorage.removeItem('feed:last_seq')
location.reload()
```

## What to Look For in New Logs

After clearing localStorage and refreshing, you should see:

```
[WsFeedClient] 🔧 Initialized: lastSeq=0 (from localStorage), resumeFromRequested=1
[WsFeedClient] 📤 Sending resume request: from_seq=1 (lastSeq was 0)
[WsFeedClient] 📦 _handleSamplesFrame called: type=history, samples=12000000
[WsFeedClient] Processing 12000000 samples of type history
[WsFeedClient] ✅ Accepted 12000000 samples, calling onSamples with 12000000 samples
[WsFeedClient] 📋 Emitting registry with 15 series
```

### If You Still See Duplicates After Clearing

Check the logs for:
```
[WsFeedClient] 🚫 Duplicate: seq=100 <= lastSeq=500 (first sample in batch)
```

This tells you:
- Server is sending seq=100
- But lastSeq=500 (meaning we already processed up to 500)

**Possible causes**:
1. Server is sending old data
2. Server sequences don't match what client expects
3. Multiple clients are writing to same localStorage

## Diagnostic: View Current State

Run this in browser console to see full diagnostic:

```javascript
// Show localStorage state
console.log('=== LOCALSTORAGE ===')
console.log('lastSeq:', localStorage.getItem('feed:last_seq'))

// Show all feed-related keys
Object.keys(localStorage).filter(k => k.includes('feed')).forEach(k => {
  console.log(`${k}:`, localStorage.getItem(k))
})

// If you want to see WHAT sequence the server is actually sending
// Look for this log after samples arrive:
// [WsFeedClient] 🚫 Duplicate: seq=XXXXX <= lastSeq=YYYYY
```

## Permanent Solution: Server-Side

Your server should:

1. **Honor the resume request**: When client sends `{ type: 'resume', from_seq: 880148 }`, server should send samples starting from seq 880148 or later

2. **Send appropriate history**: If server doesn't have data at requested sequence:
   - Send `init_complete` with `resume_truncated: true`
   - Client will know it missed data

3. **Consistent sequence numbers**: Don't reset sequences on restart
   - Persist sequence counter
   - Or include timestamp in sequence calculation

## Why It Worked Before

If this same server worked before, possible reasons:

1. **Fresh start**: No localStorage data existed, so `lastSeq=0`
2. **Sequences matched**: Server happened to have the right data
3. **Different server instance**: Previous server had persisted sequences
4. **Local storage was cleared**: Between sessions, cache was cleared

## Server Check

View your Python server's response to the resume request.

**Expected WebSocket messages** (in DevTools → Network → WS → Messages):

### Client sends:
```json
{"type": "resume", "from_seq": 880148}
```

### Server should respond:
```json
{
  "type": "init_begin",
  "min_seq": 1,
  "wm_seq": 900000,
  "ring_capacity": 12000000
}
```

Then send history/delta samples with `seq >= 880148`.

### If server sends samples with `seq < 880148`:
Those will be rejected as duplicates (which is correct behavior).

## Code Is Identical to wsfeed-client.js

I compared both implementations:

**wsfeed-client.js (line 422)**:
```javascript
// Dedup by global seq
if (seq <= this.lastSeq) continue;
```

**wsfeed-client.ts (line 494)**:
```typescript
// Dedup by global seq
if (seq <= this.lastSeq) continue;
```

**IDENTICAL**. The TypeScript version is a faithful port.

## Summary

1. **Clear localStorage**: `localStorage.clear()` then reload
2. **Check new logs**: Look for seq numbers in diagnostic logs
3. **Verify server behavior**: Make sure server honors resume requests
4. **If still failing**: Share logs showing:
   - `[WsFeedClient] 🔧 Initialized: lastSeq=...`
   - `[WsFeedClient] 📤 Sending resume request: from_seq=...`
   - `[WsFeedClient] 🚫 Duplicate: seq=... <= lastSeq=...`

The client code is working correctly. The issue is a mismatch between stored lastSeq and server's sequence numbers.
