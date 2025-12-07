# TODO.md  
## Complete UI Implementation Roadmap  
### (Consolidated from Requirements, Pipeline Docs, Layout TODO, and Core Rules)

---

# 0. Core Principles (Critical)

These rules define how the UI MUST behave:

## 0.1 Layout-Driven Rendering (Most Important Rule)
- [ ] The UI **must not plot any data series** unless a **plot layout JSON** is loaded.
- [ ] Without a layout:
  - [ ] UI continues collecting data in background.
  - [ ] UI shows series discovered in registry.
  - [ ] UI displays message: “No layout loaded. Load a plot layout JSON to visualize data.”
  - [ ] No SciChart panes are created automatically.

## 0.2 Layout JSON = Single Source of Truth
- [ ] Determines:
  - Grid size (1x1, 2x1, 1x2, 3x3, 4x4, M×N).
  - Which series goes to which pane.
  - Which panes receive hlines/vlines.
  - Which panes receive strategy markers.
  - Which pane is the PnL pane.
- [ ] UI must **never guess or auto-route** a series.
- [ ] All routing must pass through layout mapping.

## 0.3 PnL Must Have Its Own Plot
- [ ] PnL series must be visualized **only in a dedicated PnL pane**.
- [ ] PnL pane must never contain non-PnL series.
- [ ] PnL pane Y-axis supports both positive and negative ranges.

## 0.4 Strategy Markers Placement Rules
- [ ] Default: strategy markers must appear on **all panes EXCEPT**:
  - PnL pane  
  - Bar pane  
- [ ] Layout JSON may override via:
  - `strategy_markers.include_panes`
  - `strategy_markers.exclude_panes`

---

# 1. Project & Tech Foundation

## 1.1 Project Setup
- [ ] Vite + React + TypeScript
- [ ] Tailwind + shadcn/ui
- [ ] Enforce TS-only codebase (no `.js`)

## 1.2 SciChart Delivery
- [ ] Add config fields:
  - `libraries.scichart.delivery`
  - `version`
  - `cdnBaseUrl`
- [ ] Runtime CDN loader (no bundling SciChart)
- [ ] License initialization

---

# 2. Configuration System

## 2.1 Runtime Config
- [ ] Load `config.json` and `ui-config.json`
- [ ] Validate both
- [ ] Provide via React context

## 2.2 UI Config Parameters
Include:
- [ ] Theme
- [ ] HUD/toolbar auto-hide
- [ ] Minimap settings
- [ ] liveWindowMs
- [ ] Drain-loop limits
- [ ] Buffer limits
- [ ] timezone
- [ ] defaultLayout

---

# 3. WebSocket Transport & Protocol

## 3.1 Full Protocol Support
Implement all phases:
- [ ] `resume`
- [ ] `init_begin`
- [ ] `history`
- [ ] `delta`
- [ ] `init_complete`
- [ ] `live`
- [ ] `heartbeat`

## 3.2 WS Client Core
- [ ] Reconnect logic + warm resume support
- [ ] Handle:
  - `min_seq`
  - `wm_seq`
  - `resume_truncated`
- [ ] Emit status snapshots:
  - stage
  - history %
  - ingest rate
  - heartbeat lag
  - time bounds
  - resume info
- [ ] Handle binary & JSON frames

---

# 4. Ingestion Pipeline

## 4.1 IngestPort Interface
- [ ] Implement:
  - `start`
  - `stop`
  - `onBatches`
  - `onStatus`
  - `onRegistry`

## 4.2 Parsing & Batching
- [ ] Parse WS frames → typed-array batches by series_id
- [ ] Support all series types:
  - ticks
  - ohlc
  - indicator
  - bar
  - strategy signals
  - strategy pnl

## 4.3 Bounded Ingest Queue
- [ ] Configurable max size
- [ ] Drop policy + logging

## 4.4 Drain Loop
- [ ] rAF loop
- [ ] Enforce:
  - maxBatchesPerFrame
  - maxMsPerFrame
- [ ] Append to DataSeries
- [ ] Update registry

---

# 5. Series Registry

## 5.1 Registry Data
Track:
- [ ] series_id
- [ ] parsed namespace
- [ ] count
- [ ] firstSeq / lastSeq
- [ ] firstTms / lastTms
- [ ] ring_capacity

## 5.2 Emission
- [ ] Emit registry fragments to UI
- [ ] Feed SeriesBrowser

---

# 6. DataSeries Store

- [ ] Long-lived Map<series_id, DataSeries>
- [ ] Reuse on layout reload
- [ ] FIFO trimming using:
  - `pointsPerSeries`
  - `maxPointsTotal`

---

# 7. Layout System  
*(Critical for full operation)*

## 7.1 Layout JSON Schema
Include:
- [ ] grid: `[rows, cols]`
- [ ] panes:
  - id
  - title
  - row / col
  - width / height
  - overlays (hline/vline)
- [ ] PnL pane identification
- [ ] series-to-pane mapping
- [ ] strategy marker config
- [ ] **minimap.source.series_id (required)**

## 7.2 Layout Validation
- [ ] Validate unique pane IDs
- [ ] Validate rows/cols match grid definition
- [ ] Validate all series reference valid panes
- [ ] Validate overlay values
- [ ] Display errors clearly in UI

## 7.3 No Layout Behavior
- [ ] Do not create any SciChart surfaces
- [ ] Show registry only
- [ ] Show “Load layout to visualize data”
- [ ] Continue ingesting data silently

---

# 8. Dynamic Grid Rendering  
*(BLOCKER for full dynamic UI)*

## 8.1 Create `DynamicPlotGrid.tsx`
- [ ] Render grid based on layout.grid
- [ ] CSS Grid with row/column spans
- [ ] Create container div for each pane
- [ ] Render pane titles
- [ ] Use refs for pane surfaces

## 8.2 Surface Creation
- [ ] Create SciChartSurface for each pane
- [ ] Register surfaces with layout-manager
- [ ] Cleanup surfaces on layout change

## 8.3 Systems Integration
- [ ] Replace hardcoded `tick-chart` / `ohlc-chart` divs
- [ ] Sync X-axes across panes
- [ ] Handle window resize

---

# 9. Pane Surface Registry

- [ ] Maintain `Map<paneId, SciChartSurface>`
- [ ] getPaneForSeries() returns actual surface
- [ ] Destroy unused surfaces
- [ ] Prevent memory leaks

---

# 10. PnL Dedicated Plot

- [ ] Always create independent PnL pane
- [ ] Route only PnL series here
- [ ] Proper Y-axis scaling (negative + positive)
- [ ] Layout JSON must define this pane
- [ ] Strategy markers must not appear here

---

# 11. Strategy Markers

## 11.1 Placement Rules
- [ ] Default: show in all panes except PnL + bar
- [ ] Layout JSON can override (include/exclude)

## 11.2 Consolidation
- [ ] Group markers by:
  - instrument
  - strategy
  - marker type
- [ ] One annotation per group

## 11.3 Rendering
- [ ] Timestamp-based X for all non-tick panes
- [ ] Efficient annotation updates

---

# 12. Overlays (hlines, vlines)

- [ ] Read from layout:
  - pane.overlays.hline[]
  - pane.overlays.vline[]
- [ ] Create SciChart annotations
- [ ] Support:
  - labels
  - stroke color
  - thickness
  - dash patterns
- [ ] Remove/reapply overlays on layout change

---

# 13. “Waiting for Data” UI

- [ ] Create component `WaitingForData.tsx`
- [ ] Show for panes where series are defined but empty
- [ ] Hide when data arrives
- [ ] Present for minimap too

---

# 14. Mid-Run Layout Loading

- [ ] Preserve all DataSeries
- [ ] Move series between panes
- [ ] Detach/attach renderableSeries to new surfaces
- [ ] Destroy unused surfaces
- [ ] Re-sync axes
- [ ] Retain zoom/pan state if possible

---

# 15. Minimap

## 15.1 Rendering
- [ ] Separate SciChart surface
- [ ] Bound to `minimap.source.series_id`

## 15.2 Window Logic
- [ ] Live mode:
  - right edge = dataClockMs
- [ ] Paused mode:
  - window freely movable
- [ ] Draggable window edges

## 15.3 States
- [ ] “Waiting for Data” when source empty

---

# 16. Global Data Clock

- [ ] Compute dataClockMs = max(t_ms)
- [ ] Live mode: link X-range to dataClockMs
- [ ] Paused: stop auto-follow
- [ ] Jump-to-Live button + hotkey J

---

# 17. Axes

- [ ] DateTimeNumericAxis (millisecond precision)
- [ ] Timezone-based label formatting
- [ ] Link visible ranges across all panes

---

# 18. HUD

- [ ] Display:
  - stage
  - history %
  - ingest rate
  - heartbeat lag
  - global data clock
  - live/paused
- [ ] Auto-hide based on config

---

# 19. Toolbar

- [ ] Live/pause toggle
- [ ] Jump-to-Live
- [ ] Load layout
- [ ] Toggle Minimap
- [ ] Toggle Theme
- [ ] Fullscreen
- [ ] Zoom controls

---

# 20. Series Browser

- [ ] Show all discovered series
- [ ] Group by namespace
- [ ] Show metadata
- [ ] Toggle visibility
- [ ] Move series between panes

---

# 21. Command Palette

- [ ] Ctrl/Cmd+K
- [ ] Commands:
  - Load layout
  - Jump to live
  - Toggle minimap / HUD / theme
  - Fit-all
  - Open series browser

---

# 22. Interaction System

## 22.1 Mouse/Wheel
- [ ] Drag = pan
- [ ] Wheel = zoom X
- [ ] Shift + wheel = zoom Y
- [ ] Double-click = fit-all + pause

## 22.2 Zoom Modes
- [ ] Box (XY)
- [ ] X-only
- [ ] Y-only

## 22.3 Hotkeys
- [ ] B, X, Y, Z
- [ ] J (Jump to live)
- [ ] M, H, T, F
- [ ] Ctrl/Cmd+K

---

# 23. Theme

- [ ] Dark/light themes
- [ ] Persist selection
- [ ] Apply to SciChart + UI

---

# 24. Performance & Stability

- [ ] Maintain 50–60 FPS
- [ ] Handle 10M+ points
- [ ] Survive 6–8 hour runtimes
- [ ] No memory leaks
- [ ] Proper surface/DataSeries disposal
- [ ] Optional: Web Worker parsing

---

# 25. Testing & Examples

## 25.1 Test Layouts
- [ ] Single-pane
- [ ] 2×1, 1×2
- [ ] 3×3, 4×4
- [ ] Overlays
- [ ] Strategy marker routing
- [ ] PnL pane
- [ ] Minimap

## 25.2 Test Scenarios
- [ ] history → delta → live
- [ ] resume after disconnect
- [ ] long-run data ingestion
- [ ] layout switching
- [ ] strategy marker correctness
- [ ] minimap correctness

---

# END


check this all requirement and implement, I am also proving you more info below: 

the incoming data as well as the UI config JSON file. you should have a pipeline from receiving data to plotting data

you need to have a preallocated circular buffer. as you discover new series you should preallocate a circular buffer for it. its size comes from the UI config JSON file.



I have the following in the PROJECT.REQUIREMENTS.md: that's why I insist you understand it. it is very important



## **6. UI Config File**

* External JSON loaded at startup defining:

  * Performance settings
  * Default layout
  * Minimap behavior
  * Theme (dark/light)
  * WebSocket URL
  * **Timezone for DateTime axes**
  * UI behavior/thresholds
performance settings include for example the preallocation size of circular buffers, default it to 1,000,000.

have the AI design you a UI config JSON file. and send it to me to approve. this is an example to give you ideas ( you dont need to have everything in the UI, this is just an idea, you can keep it simple)



{
  "transport": { "wsUrl": "ws://127.0.0.1:8765", "binary": true, "useWorker": false },
  "ingest": { "targetTransferHz": 20, "maxPointsPerBatch": 131072 },
  "uiDrain": { "maxBatchesPerFrame": 8, "maxMsPerFrame": 6 },
  "layout": { "preserveViewportOnReload": true, "reuseXAxis": true },

  "data": {
    "registry": { "enabled": true, "maxRows": 5000 },
    "buffers":  { "pointsPerSeries": 1000000, "maxPointsTotal": 10000000 }
  },

  "minimap": {
    "enabled": true,
    "overlay": true,
    "liveWindowMs": 300000
  },

  "logging": { "level": "info", "includeStatus": true, "includeEvents": true },
  "ui": {
    "hud": { "visible": true, "mode": "minimal", "autoHideMs": 2000 },
    "toolbar": { "autoHide": true, "opacityIdle": 0.15 },
    "legend": { "peek": true, "autoHideMs": 2000 },
    "density": "compact",
    "theme": { "default": "dark", "allowToggle": true }     // NEW: dark/light theme toggle
  },

  "libraries": {
    "scichart": {
      "delivery": "cdn",                                    // NEW: load SciChart via CDN (no local bundle)
      "version": "X.Y.Z",
      "cdnBaseUrl": "https://cdn.jsdelivr.net/npm/scichart@X.Y.Z/_wasm"
    }
  }
} 
an idea for pipeline:



┌──────────────────────────┐
│  WS Feed (local)         │  tick/ohlc data, JSON or binary
└────────────┬─────────────┘
             │
       (Main or Worker Ingest)
             │
             ▼
┌──────────────────────────┐
│  Ingest Port             │
│  - parse → batches       │
│  - post to queue         │
└────────────┬─────────────┘
             │
     rAF-bounded drain
             │
             ▼
┌──────────────────────────┐
│  DataSeries Store        │
│  (series_id → DataSeries)│
└────────────┬─────────────┘
             │
     unified loadLayout()
             │
             ▼
┌──────────────────────────────┐
│  Multi-Surface Layout        │
│  ┌───────────────┐           │
│  │Surface A      │           │
│  ├───────────────┤           │
│  │Surface B      │  linked X │
│  ├───────────────┤           │
│  │Surface C      │           │
│  └───────────────┘           │
│  ↑ shared minimap (overlay)  │
└──────────────────────────────┘
you may already have this. the UI should be able to load a Plot Layout JSON file and change the panes from one thing to another. for example, we may have a 1x1 grid and with a new layout we may change it to 3x3 grid showing ticks and OHLC and PnL without losing any data that has been collected so far.

the incoming data as well as the UI config JSON file. you should have a pipeline from receiving data to plotting data

you need to have a preallocated circular buffer. as you discover new series you should preallocate a circular buffer for it. its size comes from the UI config JSON file.



I have the following in the PROJECT.REQUIREMENTS.md: that's why I insist you understand it. it is very important



## **6. UI Config File**

* External JSON loaded at startup defining:

  * Performance settings
  * Default layout
  * Minimap behavior
  * Theme (dark/light)
  * WebSocket URL
  * **Timezone for DateTime axes**
  * UI behavior/thresholds
performance settings include for example the preallocation size of circular buffers, default it to 1,000,000.

have the AI design you a UI config JSON file. and send it to me to approve. this is an example to give you ideas ( you dont need to have everything in the UI, this is just an idea, you can keep it simple)



{
  "transport": { "wsUrl": "ws://127.0.0.1:8765", "binary": true, "useWorker": false },
  "ingest": { "targetTransferHz": 20, "maxPointsPerBatch": 131072 },
  "uiDrain": { "maxBatchesPerFrame": 8, "maxMsPerFrame": 6 },
  "layout": { "preserveViewportOnReload": true, "reuseXAxis": true },

  "data": {
    "registry": { "enabled": true, "maxRows": 5000 },
    "buffers":  { "pointsPerSeries": 1000000, "maxPointsTotal": 10000000 }
  },

  "minimap": {
    "enabled": true,
    "overlay": true,
    "liveWindowMs": 300000
  },

  "logging": { "level": "info", "includeStatus": true, "includeEvents": true },
  "ui": {
    "hud": { "visible": true, "mode": "minimal", "autoHideMs": 2000 },
    "toolbar": { "autoHide": true, "opacityIdle": 0.15 },
    "legend": { "peek": true, "autoHideMs": 2000 },
    "density": "compact",
    "theme": { "default": "dark", "allowToggle": true }     // NEW: dark/light theme toggle
  },

  "libraries": {
    "scichart": {
      "delivery": "cdn",                                    // NEW: load SciChart via CDN (no local bundle)
      "version": "X.Y.Z",
      "cdnBaseUrl": "https://cdn.jsdelivr.net/npm/scichart@X.Y.Z/_wasm"
    }
  }
} 
an idea for pipeline:



┌──────────────────────────┐
│  WS Feed (local)         │  tick/ohlc data, JSON or binary
└────────────┬─────────────┘
             │
       (Main or Worker Ingest)
             │
             ▼
┌──────────────────────────┐
│  Ingest Port             │
│  - parse → batches       │
│  - post to queue         │
└────────────┬─────────────┘
             │
     rAF-bounded drain
             │
             ▼
┌──────────────────────────┐
│  DataSeries Store        │
│  (series_id → DataSeries)│
└────────────┬─────────────┘
             │
     unified loadLayout()
             │
             ▼
┌──────────────────────────────┐
│  Multi-Surface Layout        │
│  ┌───────────────┐           │
│  │Surface A      │           │
│  ├───────────────┤           │
│  │Surface B      │  linked X │
│  ├───────────────┤           │
│  │Surface C      │           │
│  └───────────────┘           │
│  ↑ shared minimap (overlay)  │
└──────────────────────────────┘
you may already have this. the UI should be able to load a Plot Layout JSON file and change the panes from one thing to another. for example, we may have a 1x1 grid and with a new layout we may change it to 3x3 grid showing ticks and OHLC and PnL without losing any data that has been collected so far.

How do you know which data series goes to which plot?

Strategy markers should go to all plots except the pnl and bar plots. The plot layout json file should tell you where to plot the strategy markers.

Plot layout json file is a very important file for my UI. Without it the UI never knows how to plot data series discovered in Data Registry

We cant blindly plot data. The UI collect data in the background continuously. The UI shows data series discovered, it's the users job to load plot layout json file to let the UI know how to plot, the grid, which data series goes to which plot, ...

this is an example, it is not complete, but it gives you idea what the Plot Layout JSON file is.

{
  "layout_mode": "multi_surface",
  "grid": [2, 2],

  "minimap": {
    "source": {
      "series_id": "ES.c.0:ticks",
      "yField": "y"
    }
  },

  "panes": [
    {
      "id": "topLeft",
      "row": 0,
      "col": 0,
      "height": 1,
      "width": 1,
      "overlays": {
        "hline": [
          { "id": "zero",  "y": 0,  "label": "0" },
          { "id": "rsi30", "y": 30, "label": "30", "style": { "strokeDashArray": [6, 4] } },
          { "id": "rsi70", "y": 70, "label": "70", "style": { "strokeDashArray": [6, 4] } }
        ]
      }
    },
    { "id": "topRight",    "row": 0, "col": 1, "height": 1, "width": 1 },
    { "id": "bottomLeft",  "row": 1, "col": 0, "height": 1, "width": 1 },
    {
      "id": "bottomRight",
      "row": 1,
      "col": 1,
      "height": 1,
      "width": 1,
      "overlays": {
        "hline": [
          { "id": "baseline", "y": 0, "label": "0" }
        ]
      }
    }
  ],
  "series": [
    { "series_id": "ES.c.0:ticks",            "pane": "topLeft",     "type": "FastLineRenderableSeries" },
    { "series_id": "ES.c.0:sma_10",           "pane": "topLeft",     "type": "FastLineRenderableSeries" },
    { "series_id": "ES.c.0:ohlc_time:10000",  "pane": "bottomLeft",  "type": "FastCandlestickRenderableSeries" },
    { "series_id": "ES.c.0:ohlc_time:30000",  "pane": "bottomRight", "type": "FastCandlestickRenderableSeries" }
  ],
  "meta": { "version": "1.1" }
}
Again, that's just an example of what I have in mind. you should come up with a better one.

ticks, and tick indicators and bar indicators and PnL will use FastLineRenderableSeriesand OHLC will use FastCandlestickRenderableSeries

the UI should work at cold-start and mid-run plot layout loading with no issue. there should be one pipeline for cold-start and mid-run loading in terms of pane creation. you always read a the plot layout to create plots. at cold start you should see what the default is in the UI config JSON file.

if data has not arrived for a specific plot, the UI should say Waiting for Data, ... until the data arrives. The UI should not crash. . for example, for 60-minute OHLC bar it may take some time for the bar to show up and hence the UI should not crash. same for PnL, the data for PnL might arrive later.

again, it is the user's responsibility to load the proper plot layout json file to correctly plot the data in Data Registry. 

data series type can be FastMountainRenderableSeries , FastLineRenderableSeriesand , or FastCandlestickRenderableSeries


Some of the plot layout json files are optional, for example hline/vline...

All panes must have their own x axis, all linked and synchronized

All loaded plot layout json file should be somewhere i the UI toolbar. 

Whatever goes on UI plots should be able to be configured by the Plot Layout JSON file.

For example line width for a line plot
You need to have an engine or a class or a function, that gets a json and create the entire grid with line objects, axes, linking axes, optional hlines ans vlines, marker objects...



You will use this engine at start up (cold start) using the default plot layout json file and mid-run by loading a json file

This is the idea of a pipeline. Separation of concerns. Each component does something dedicated and specific. This way any change will be easy.
From data ingestion to plot creation to plot update... -> pipeline



Final note: (If any of these are already exactly implemented you can skip)


