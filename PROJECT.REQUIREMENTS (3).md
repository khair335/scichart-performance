# **Project Requirements**

## **Overview**

Build a **browser-based real-time charting UI** using **SciChart JS**, capable of handling **high-frequency market data** smoothly for 6–8 hours.
The UI must support **dynamic layouts**, **live/paused modes**, **strategy and PnL visualization**, **rich plot interaction**, and ingest from a **resume-capable WebSocket feed**.

Target throughput:

* ~1–2M tick samples per session (≈100 ticks/sec)
* 5–9 derived metrics → ~10M total data points
* User can toggle each series on/off (visibility)
* Smooth plot interaction with all 10M data points displayed (50-60 FPS) 
* **All charts use millisecond-precision DateTime X-axes** (timezone defined in config)

---

## **Core Features**

### **1. Multi-Pane Real-Time Charting**

* Multi-surface charts with **line**, **OHLC**, and optional **PnL** plots.
* **Each pane must have a plot title**, provided by layout or auto-generated.
* **Linked X-time window** across all panes; independent Y-axes per pane.
* Must run **smoothly at 50–60 FPS** under continuous streaming load.

### **2. Live / Paused Modes & Interactions**

* **Live**: X-range auto-scrolls using the **global data clock** (not system time).
* **Paused**: free exploration with pan/zoom.
* Standard interactions:

  * **Box zoom** (rectangle)
  * Horizontal-only zoom
  * Vertical-only zoom
  * Mouse wheel zoom
  * Axis dragging
* **SciChartOverview minimap** controls full-range navigation and Live/Paused window anchoring, and user-selected windowing/sliding — including the ability to display the entire collected dataset.

### **3. Dynamic JSON Layout (Runtime Reloadable)**

* The toolbar includes a button to **load a JSON plot layout file** at runtime.
* Layout JSON defines:

  * Pane grid
  * Plot titles
  * Assigned data series
  * Optional overlays (e.g., hlines)
  * Optional PnL pane
* Layout reload **must not lose any data** (existing DataSeries are reused).
* Layout must include a **minimap source series**.
* If a referenced series has not produced data yet (e.g., 60-minute OHLC bars):

  * Pane must show a non-blocking **“Waiting for data…”** message
  * UI must not error or crash
  * Pane auto-populates once data arrives

---

### **4. Strategy Markers (Grouped Objects)**

* Strategy entry/exit markers rendered visually on the charts.
* **All markers of the same tag/type are consolidated into ONE SciChart annotation series**—not one object per marker.

  * Example: all `strategy:long:entry` share one annotation series
  * Example: all `strategy:long:exit` share another

---

### **5. Data Ingest Pipeline**

* WebSocket client supports:
  **resume → init_begin → history → delta → init_complete → live → heartbeat**
* Strict sequence-number deduplication; no gaps or duplicates on reconnect.
* Typed-array batches appended to SciChart DataSeries.
* **Registry** tracks all discovered series (ticks, SMA, VWAP, bars, strategy, PnL).
* The UI must maintain a **global data clock (`dataClockMs`)** computed from incoming `t_ms`.
* The global clock drives Live mode, minimap anchoring, and HUD display.
* Proper behavior under reconnects and long sessions.

---

## **6. UI Config File**

* External JSON loaded at startup defining:

  * Performance settings
  * Default layout
  * Minimap behavior
  * Theme (dark/light)
  * WebSocket URL
  * **Timezone for DateTime axes**
  * UI behavior/thresholds

---

## **7. UI Features**

* **Maximize plot real-estate** (minimal permanent UI chrome).
* **HUD** showing:

  * Connection status
  * Ingest rate
  * Heartbeat lag
  * Live/Paused mode
  * **Global data clock (current data timestamp)**
* **Toolbar** with:

  * Load layout JSON
  * Theme toggle (dark/light)
  * Minimap toggle
  * Jump-to-Live
* **Command palette (Ctrl/⌘+K)** for quick actions.
* **Series browser drawer** for selecting which series are visible and to move series between panes.
* Overlays (HUD / toolbar / palette / drawers) auto-hide when inactive.
* **No toast notifications** (requirement removed).

---

## **8. Performance & Stability**

* Must maintain a **smooth 50–60 FPS** render rate.
* Must handle a full 8-hour session without memory leaks.
* Layout reloads and reconnects must be seamless and glitch-free.
* UI must remain responsive even during heavy streaming.

---

## **Deliverables Summary**

Developer must deliver:

* Multi-pane SciChart layout with runtime-reloadable JSON layouts and per-pane titles.
* Full WebSocket ingest integration (resume, dedupe, registry, **global data clock UI**).
* Strategy marker system with **grouped marker objects per tag/type**.
* Config-driven UI (including timezone).
* All UI overlays (HUD, toolbar, palette, drawer, legend).
* Live/Paused modes with minimap integration and proper “waiting for data” behavior.
* Dark/Light theme switch.
* Stable high-performance rendering at **50–60 FPS** with all 10M data points displayed (with smooth plot interaction, no sluggishness). 
  * Similar to 
    * https://www.scichart.com/demo/javascript/javascript-chart-realtime-performance-demo and 
    * https://www.scichart.com/demo/javascript/realtime-ticking-stock-charts