
## Root Cause Analysis: Why Reset Cursor / F5 Is Sometimes Needed

After a thorough audit of `useWebSocketFeed.ts`, `TradingChart.tsx`, and `wsfeed-client.ts`, there are **three distinct bugs** causing the inconsistent behavior. All three need to be fixed together.

---

### Bug 1: The Critical Race Condition — `ui-config.json` Loads After WebSocket Connects

This is the **primary root cause** of the inconsistency.

**What happens on every page load:**

```text
Time 0ms:   TradingChart renders
             cursorPolicy state = 'from_start'   ← correct
             useWebSocketFeed() is called

Time ~0ms:  useWebSocketFeed auto-connect fires
             cursorPolicyRef.current = 'from_start'  ← correct at this moment
             WsFeedClient created with policy = 'from_start'
             WebSocket connects → sends { type: "resume", from_seq: 1 }
             ✅ This works correctly

Time ~50ms: ui-config.json fetch completes (async)
             if config.transport.cursorPolicy exists → setCursorPolicy(newPolicy)
             wsSetCursorPolicy(newPolicy) is also called on the live client

Time ~200ms: auto-reconnect fires (because autoReconnectInitialDelayMs=500ms)
              OR server sends new data → client is already at seq=N
              On next reconnect: cursorPolicyRef.current = whatever config said
```

**The inconsistency:** If `ui-config.json` contains `cursorPolicy: "resume"` or `cursorPolicy: "auto"`, it overwrites the initial `from_start` policy mid-session (line 335-338 in TradingChart.tsx). The next auto-reconnect then resumes from the last seen seq instead of seq=1. Whether this causes visible data loss depends on timing — it is **non-deterministic**, which explains why it "works sometimes."

The specific code path (TradingChart.tsx line 335-338):
```typescript
if (config.transport.cursorPolicy && ['auto', 'resume', 'from_start'].includes(config.transport.cursorPolicy)) {
  setCursorPolicy(config.transport.cursorPolicy as CursorPolicy);  // changes state
  wsSetCursorPolicy(config.transport.cursorPolicy as any);         // changes live client mid-flight
}
```

---

### Bug 2: `_persistCursor` Writes to localStorage During Normal Operation

Even with `useLocalStorage: false`, the `WsFeedClient` **still calls `_persistCursor` on every accepted sample batch** (line 1010 in wsfeed-client.ts):
```typescript
this._cursorSeq = Math.max(this._cursorSeq, this._acceptAfterSeq);
this._persistCursor(this._cursorSeq);  // ← this writes to storage!
```

The `_persistCursor` method only skips writing if `this.storage === null`. But when `useLocalStorage: false`, the `connect()` function in `useWebSocketFeed` passes `new MemoryStorage()` (not `null`). So it writes cursor values into in-memory storage — which is fine — but **the storageKey used is `wsfeed:last_seq:ws://127.0.0.1:8765`**, which is the same key the localStorage-clear-on-mount code targets.

**The real exposure:** If the user changes `useLocalStorage` to `true` via the ConnectionControls UI (which is visible by default), then switches it back to `false`, the localStorage cursor is NOT cleared — because the mount-time cleanup already ran. So the next auto-reconnect picks up the stale cursor.

---

### Bug 3: Auto-Reconnect Fires Before `handleSamplesRef` Is Populated

There is a buffering mechanism (`pendingSamplesRef`) to handle samples received before `handleSamples` is ready, but there's a subtle issue:

- `useWebSocketFeed` is called at React render time → auto-connects immediately
- `useMultiPaneChart` is called after → `appendSamples` is created later
- `handleSamples` is only assigned to `handleSamplesRef` in a `useEffect` (runs after render)
- If the server is fast enough to send history frames **before** the first `useEffect` flush, those samples go into `pendingSamplesRef`
- They are flushed when `handleSamples` becomes available — but this depends on whether `isReady` (SciChart initialization) is already true

This is a secondary cause and typically only manifests on very fast local connections (localhost server).

---

### The Fix: Simplify to Always `from_start`, Remove All Sources of Inconsistency

The proposed fix removes all three bugs by simplifying the connection model — which is exactly what the user wants. The changes are:

**1. Hardcode `cursorPolicy = 'from_start'` — never allow it to be overridden by `ui-config.json`**

In `TradingChart.tsx`: Remove the block that reads `config.transport.cursorPolicy` and calls `wsSetCursorPolicy`. The policy is `from_start`, period. This eliminates Bug 1.

**2. Pass `storage: null` to `WsFeedClient` instead of `MemoryStorage`**

In `useWebSocketFeed.ts`: When `useLocalStorage` is `false`, pass `null` for storage (not `new MemoryStorage()`). This means `_persistCursor` does nothing, and there is no stale cursor anywhere. This eliminates Bug 2.

**3. Remove the `ConnectionControls` component entirely**

Remove the panel from the UI. This prevents the user from accidentally changing `cursorPolicy`, `useLocalStorage`, or triggering a `Disconnect` that leaves the feed in a partial state. The user's only reset mechanism becomes F5 — which is clean and always works.

**4. Keep `resetDataState + sharedDataSeriesPool.clearAllData + wsResetCursor(true)` accessible via a single clean "Reset" button in the Toolbar**

So the user can still reload data without F5 when needed (e.g. after server restart). This is now a single atomic action instead of three separate controls.

**5. Add a small read-only connection status indicator to the HUD**

Show `ws://127.0.0.1:8765` + a color-coded dot (green=live, yellow=history, red=disconnected) directly in the HUD bar. This replaces the full ConnectionControls panel for operators who need to know which server they're connected to.

---

### Files to Change

| File | Change |
|---|---|
| `src/hooks/useWebSocketFeed.ts` | Pass `storage: null` when `useLocalStorage` is false; remove the `MemoryStorage` fallback |
| `src/components/chart/TradingChart.tsx` | Remove `cursorPolicy` state, hardcode `'from_start'`; remove `config.transport.cursorPolicy` override; remove `ConnectionControls` render; remove `connectionControlsVisible` state and toggle; add "Reset" button to toolbar |
| `src/components/chart/Toolbar.tsx` | Remove `onToggleConnectionControls` prop and its button; add `onReset` prop for the single reset button |
| `src/components/chart/HUD.tsx` | Add read-only WS URL + connection status dot |
| `src/components/chart/ConnectionControls.tsx` | Delete the file (nothing will import it) |

### What Changes for the User

- **Before:** Sometimes need Reset Cursor or F5 to get all data — non-deterministic, depends on timing of ui-config.json load vs auto-reconnect
- **After:** Always starts from seq=1, always gets full history, no controls to accidentally misconfigure. F5 = fresh start. One "Reset" button in toolbar for server-restart scenarios.
- **Visible change:** The connection controls panel disappears. A small status dot + URL appears in the HUD bar.
