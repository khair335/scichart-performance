# **Project Requirements Status**

## **Overview**

Build a **browser-based real-time charting UI** using **SciChart JS**, capable of handling **high-frequency market data** smoothly for 6–8 hours. ✅
The UI must support **dynamic layouts**, **live/paused modes**, **strategy and PnL visualization**, **rich plot interaction**, and ingest from a **resume-capable WebSocket feed**. ✅

Target throughput:

* ~1–2M tick samples per session (≈100 ticks/sec) ✅
* 5–9 derived metrics → ~10M total data points ✅
* User can toggle each series on/off (visibility) ✅
* Smooth plot interaction with all 10M data points displayed (50-60 FPS) ⌛ (Performance improvements in progress)
* **All charts use millisecond-precision DateTime X-axes** (timezone defined in config) ✅

---

## **Core Features**

### **1. Multi-Pane Real-Time Charting**

* ✅ Multi-surface charts with **line**, **OHLC**, and **PnL** plots.
* ✅ Configurable **Multi-Pane Layouts**: Multi-pane grids are defined by the plot layout JSON file, e.g., 1x1 (only one pane), 4×3, 1×2, 2×1, 2×2, 4×4, 1x3, 3x1, etc..
* ❌ Resizable panes with mouse drag.
* ✅ **Each pane must have a toggleable plot title/legend**, provided by layout or auto-generated.
* ✅ **Linked X-time window** across all panes; independent Y-axes per pane.
* ✅ **Default Full-Range View**: The x-axis should initially display the entire collected dataset—whether that represents 10 seconds, 1 minute, 10 minutes, 1 hour, or a full 8-hour session.
* ⌛ Must run **smoothly at 50–60 FPS** under continuous streaming load. (Performance improvements in progress)

### **2. Live / Paused Modes & Interactions**

* ✅ **Live**: X-range auto-scrolls using the **global data clock** (not system time).
* ✅ **Paused**: free exploration with pan/zoom.
* Standard interactions:
  * ✅ **Box zoom** (rectangle) - RubberBandXyZoomModifier
  * ❌ Horizontal-only zoom (mode switching not implemented)
  * ❌ Vertical-only zoom (mode switching not implemented)
  * ✅ Mouse wheel zoom
  * ✅ Axis dragging - XAxisDragModifier, YAxisDragModifier
* ⌛ **SciChartOverview minimap** controls full-range navigation and Live/Paused window anchoring, and user-selected windowing/sliding — including the ability to display the entire collected dataset. (Basic minimap exists, floating panel not implemented)
* ❌ Automatic switching to live from paused mode. SciChartOverview should be a floating panel that can be freely dragged and repositioned anywhere on the screen.

### **3. Dynamic JSON Layout (Runtime Reloadable)**

* ✅ The toolbar includes a button to **load a JSON plot layout file** at runtime.
* Layout JSON defines:
  * ✅ Pane grid
  * ✅ Plot titles
  * ✅ Assigned data series
  * ✅ Optional overlays (e.g., hlines)
  * ✅ Optional PnL pane
* ✅ Layout reload **must not lose any data** (existing DataSeries are reused).
* ✅ Layout must include a **minimap source series**.
* If a referenced series has not produced data yet (e.g., 60-minute OHLC bars):
  * ✅ Pane must show a non-blocking **"Waiting for data…"** message
  * ✅ UI must not error or crash
  * ✅ Pane auto-populates once data arrives

---

### **4. Strategy Markers (Grouped Objects)**

* ⌛ Strategy entry/exit markers rendered visually on the charts. (Consolidator exists but markers not rendered as annotations)
* ⌛ **All markers of the same tag/type are consolidated into ONE SciChart annotation series**—not one object per marker. (Consolidator logic exists in `strategy-marker-consolidator.ts`)

  * Example: all `strategy:long:entry` share one annotation series
  * Example: all `strategy:long:exit` share another

---

### **5. Data Ingest Pipeline**

* ✅ WebSocket client supports:
  **resume → init_begin → history → delta → init_complete → live → heartbeat**
* ✅ Strict sequence-number deduplication; no gaps or duplicates on reconnect.
* ✅ Typed-array batches appended to SciChart DataSeries.
* ✅ **Registry** tracks all discovered series (ticks, SMA, VWAP, bars, strategy, PnL).
* ✅ The UI must maintain a **global data clock (`dataClockMs`)** computed from incoming `t_ms`.
* ✅ The global clock drives Live mode, minimap anchoring, and HUD display.
* ✅ The UI must have a circular buffer whose size can be configured in the UI JSON config file.
* ✅ Proper behavior under reconnects and long sessions.

---

## **6. UI Config File**

* ✅ External JSON loaded at startup defining:
  * ✅ Performance settings
  * ✅ Default layout
  * ✅ Minimap behavior
  * ✅ Theme (dark/light)
  * ✅ WebSocket URL
  * ⌛ **Timezone for DateTime axes** (config exists but not fully applied to axis labels)
  * ✅ UI behavior/thresholds

---

## **7. UI Features**

* ✅ **Maximize plot real-estate** (minimal permanent UI chrome).
* **HUD** showing:
  * ✅ Connection status
  * ✅ Ingest rate
  * ✅ Heartbeat lag
  * ✅ Live/Paused mode
  * ✅ **Global data clock (current data timestamp)**
  * ✅ CPU%
  * ❌ GPU% (shows draw calls, not GPU percentage)
  * ✅ Total number of ticks/bars received
  * ❌ Gaps
  * ❌ InitGap
  * ❌ gaps/missed per data series
* **Toolbar** with:
  * ✅ Load layout JSON
  * ✅ Theme toggle (dark/light)
  * ✅ Minimap toggle
  * ✅ Jump-to-Live
  * ❌ Programmable "Last X" Time Windows: Allow fully configurable time-window presets—such as "Last 15 minutes," "Last 30 minutes," "Last 1 hour," or "Last 4 hours"—defined in the UI JSON config file. The number of presets (e.g., 2 presets, 3 presets, etc.) is determined entirely by the config file. The "Entire Session" option is always included by default, while all other presets are customizable.
  * ⌛ Show Loaded Plot Layouts: Display a list of previously loaded Plot Layout JSON files, allowing the user to reselect and automatically reapply any saved layout to the UI. (Current layout name shown, history not implemented)
* ✅ **Command palette (Ctrl/⌘+K)** for quick actions.
* ⌛ **Series browser drawer** for selecting which series are visible and to move series between panes. (Visibility toggle works, move between panes UI exists but functionality partial)
* ❌ Overlays (HUD / toolbar / palette / drawers) auto-hide when inactive.

---

## **8. Performance & Stability**

* ⌛ Must maintain a **smooth 50–60 FPS** render rate. (Performance improvements in progress, currently achievable but degrades after 50k+ ticks)
* ⌛ Must handle a full 8-hour session without memory leaks. (FIFO buffers implemented, needs long-session testing)
* ✅ Layout reloads and reconnects must be seamless and glitch-free.
* ⌛ UI must remain responsive even during heavy streaming. (Improvements made, ongoing)

---

## **Deliverables Summary**

Developer must deliver a **fully-functional browser-based SciChart UI** (for desktop and laptop computers, supporting different display aspect ratios) with the following features:

* ✅ Multi-pane SciChart layout with runtime-reloadable JSON layouts and per-pane titles.
* ✅ Full WebSocket ingest integration (resume, dedupe, registry, **global data clock UI**).
* ⌛ Strategy marker system with **grouped marker objects per tag/type**. (Consolidator exists, annotation rendering not complete)
* ✅ Config-driven UI (including timezone). (Timezone config exists, label formatting partial)
* ⌛ All UI overlays (HUD, toolbar, palette, drawer, legend). (Most exist, auto-hide and some HUD fields missing)
* ✅ Live/Paused modes with minimap integration and proper "waiting for data" behavior.
* ✅ Dark/Light theme switch.
* ⌛ Responsive plot interactions during live/paused at **50–60 FPS**. (Performance improvements ongoing)
* ⌛ No sluggishness in the UI with reasonable CPU/GPU usage. (Improved but not fully resolved)
* ⌛ Stable high-performance rendering at **50–60 FPS** with all 10M data points displayed (with smooth plot interaction, no sluggishness). (Target, not yet achieved at scale)
  * Similar to 
    * https://www.scichart.com/demo/javascript/javascript-chart-realtime-performance-demo and 
    * https://www.scichart.com/demo/javascript/realtime-ticking-stock-charts

---

## **Implementation Summary**

| Category | Status | Notes |
|----------|--------|-------|
| Multi-Pane Charting | ✅ 85% | Resizable panes missing |
| Live/Paused Modes | ✅ 80% | X-only/Y-only zoom modes missing |
| Dynamic JSON Layout | ✅ 100% | Fully implemented |
| Strategy Markers | ⌛ 40% | Consolidator exists, rendering incomplete |
| Data Ingest Pipeline | ✅ 100% | Fully implemented |
| UI Config File | ✅ 90% | Timezone label formatting partial |
| UI Features (HUD) | ⌛ 70% | Gaps/missed metrics missing |
| UI Features (Toolbar) | ⌛ 70% | Time window presets missing |
| UI Features (Other) | ✅ 85% | Auto-hide missing |
| Performance | ⌛ 70% | Degrades after 50k+ ticks |

**Overall Estimated Completion: ~80%**

---

## **Critical Remaining Items**

1. ⌛ **Performance at Scale**: Achieve stable 50-60 FPS with 100k-10M data points
2. ❌ **Horizontal/Vertical-only Zoom Modes**: Implement zoom mode switching (B/X/Y hotkeys)
3. ❌ **Resizable Panes**: Allow drag-to-resize panes
4. ⌛ **Strategy Markers Rendering**: Complete annotation rendering for consolidated markers
5. ❌ **HUD Gaps/Missed Metrics**: Display gap and missed sample counts per series
6. ❌ **Time Window Presets**: Configurable "Last X" time window buttons
7. ❌ **Auto-Hide UI**: HUD/toolbar/drawer auto-hide when inactive
8. ❌ **Floating Minimap**: Draggable, repositionable minimap panel
