# User Manual: Real-Time Trading Chart Application

## Table of Contents

1. [Introduction](#1-introduction)
2. [Quick Start Guide](#2-quick-start-guide)
3. [User Interface Components](#3-user-interface-components)
4. [Keyboard Shortcuts](#4-keyboard-shortcuts)
5. [Chart Interactions](#5-chart-interactions)
6. [Configuration Files](#6-configuration-files)
7. [Layout JSON Reference](#7-layout-json-reference)
8. [WebSocket Server Reference](#8-websocket-server-reference)
9. [Debugging and Troubleshooting](#9-debugging-and-troubleshooting)
10. [Performance Tips](#10-performance-tips)
11. [Example Layouts](#11-example-layouts)

---

## 1. Introduction

### Purpose

This application is a high-performance, browser-based real-time charting system designed for visualizing high-frequency market data. It supports:

- **Multi-pane layouts** with linked X-axes and independent Y-axes
- **Multiple chart types**: Line charts, OHLC candlesticks, Mountain (area) charts, PnL curves
- **Strategy visualization** with entry/exit markers
- **Live streaming** at 50-60 FPS with millions of data points
- **Resume-capable** WebSocket feed with sequence-number deduplication

### Technology Stack

- **Frontend**: React + TypeScript + Vite
- **Charting**: SciChart.js (WebGL-accelerated)
- **Data Feed**: WebSocket with binary/JSON support
- **Styling**: Tailwind CSS with dark/light theme support

### Target Use Case

Designed for traders and quantitative analysts who need to:
- Monitor real-time market data with sub-second latency
- Visualize multiple instruments and indicators simultaneously
- Track strategy performance with PnL curves and trade markers
- Handle 8+ hour sessions without memory degradation

---

## 2. Quick Start Guide

### Prerequisites

1. **Python 3.8+** (for the WebSocket server)
2. **Modern browser** (Chrome, Firefox, Edge - WebGL2 required)
3. **Node.js 18+** (for development only)

### Step 1: Start the WebSocket Server

```bash
# Basic usage with default settings
python server.py

# Custom configuration
python server.py --port 8765 --instrument MESU5 --price-model randomwalk --tick-rate 100

# Multiple indicators and bars
python server.py --sma-windows 10,20,50 --bar-intervals 1,5,15 --strategies strategy1,strategy2
```

### Step 2: Access the UI

1. Open your browser to the application URL (default: `http://localhost:5173`)
2. The application will automatically attempt to connect to `ws://127.0.0.1:8765`
3. Wait for the "LIVE" indicator in the HUD

### Step 3: Load a Layout

1. The default layout loads automatically from `ui-config.json`
2. To load a different layout, use the Toolbar's layout selector
3. Or use Command Palette (`Ctrl/Cmd+K`) and search for "layout"

### Troubleshooting Initial Connection

| Symptom | Solution |
|---------|----------|
| "CONNECTING..." stays forever | Verify server is running on correct port |
| "ERROR" status | Check browser console for WebSocket errors |
| "Waiting for Data" in chart | Server connected but no data yet - wait a few seconds |
| Charts empty after data | Check layout JSON matches server series IDs |

---

## 3. User Interface Components

### 3.1 HUD (Heads-Up Display)

The HUD provides real-time status information in a compact overlay at the top of the chart area.

| Indicator | Description |
|-----------|-------------|
| **Connection Status** | LIVE (green), HISTORY (blue), CONNECTING (yellow), ERROR (red) |
| **Data Clock** | Current timestamp of the most recent data point |
| **FPS** | Frames per second (target: 50-60) |
| **Data Rate** | Samples received per second |
| **Heartbeat Lag** | Latency to server heartbeat (ms) |
| **Tick Count** | Total data points received |
| **Gaps** | Number of detected sequence gaps |
| **Auto-Scroll** | Indicates if chart is auto-scrolling with live data |

**Toggle HUD**: Press `H` or use Toolbar button

### 3.2 Toolbar

The main control bar at the top of the application.

#### Playback Controls
| Button | Function |
|--------|----------|
| **▶/⏸ Live/Pause** | Toggle between live streaming and paused exploration mode |
| **⏭ Jump to Live** | Return to live data edge (also keyboard `J`) |

#### Cursor & Zoom
| Button | Function |
|--------|----------|
| **Cursor Toggle** | Enable/disable crosshair cursor |
| **Legends Toggle** | Show/hide series legends |
| **Box Zoom (B)** | Click-drag to zoom into a rectangular area |
| **X-Zoom (X)** | Zoom only horizontally |
| **Y-Zoom (Y)** | Zoom only vertically |
| **Fit All (Z)** | Zoom to show all data (zoom extents) |

#### Time Window Presets
Dropdown to quickly set X-axis to show:
- Last 15 minutes
- Last 30 minutes
- Last 1 hour
- Last 4 hours

(Presets are configurable in `ui-config.json`)

#### Layout Controls
| Control | Function |
|---------|----------|
| **Layout Selector** | Dropdown showing current layout file |
| **Reload** | Reload the current layout from file |
| **History** | Load a different layout from available files |

#### Additional Controls
| Button | Function |
|--------|----------|
| **Series Browser** | Open the Series Browser panel |
| **Minimap Toggle (M)** | Show/hide the overview minimap |
| **Command Palette** | Open command search (`Ctrl/Cmd+K`) |
| **Theme Toggle (T)** | Switch between dark and light themes |
| **Fullscreen (F)** | Toggle fullscreen mode |
| **HUD Toggle** | Show/hide the HUD overlay |
| **Connection Controls** | Show/hide connection settings panel |
| **Debug Panel** | Open the debugging panel |

### 3.3 Connection Controls Panel

Located at the top of the interface when visible.

| Control | Description |
|---------|-------------|
| **WebSocket URL** | Server address (default: `ws://127.0.0.1:8765`) |
| **Cursor Policy** | How to handle reconnection: `auto`, `resume`, `from_start` |
| **Connect** | Establish WebSocket connection |
| **Disconnect** | Close active connection |
| **Reset Cursor** | Clear stored cursor position |
| **Auto-Reconnect** | Automatically reconnect on disconnection |
| **Use LocalStorage** | Persist cursor position across sessions |

#### Cursor Policies Explained

| Policy | Behavior |
|--------|----------|
| `from_start` | Always replay all historical data from the beginning |
| `resume` | Resume from last known sequence number |
| `auto` | Let server decide based on connection state |

### 3.4 Series Browser

A panel for managing series visibility and placement.

#### Features
- **View All Series**: See every series discovered from the data feed
- **Toggle Visibility**: Click checkbox to show/hide individual series
- **Group by Type**: Series organized by category:
  - Tick (price ticks)
  - Indicator (SMAs, etc.)
  - OHLC (candlestick data)
  - Signal (trading signals)
  - Marker (strategy entry/exit)
  - PnL (profit/loss curves)
- **Move Between Panes**: Drag or select destination pane for a series
- **Select All / Select None**: Bulk visibility toggles

#### Opening the Series Browser
1. Click "Series" button in Toolbar, or
2. Use Command Palette (`Ctrl/Cmd+K`) → "Series Browser"

### 3.5 Command Palette

A keyboard-driven command interface for quick access to all features.

#### Opening
- Press `Ctrl+K` (Windows/Linux) or `Cmd+K` (Mac)
- Or click the command button in the Toolbar

#### Available Commands
| Command | Action |
|---------|--------|
| Jump to Live | Return to live data edge |
| Toggle Pause | Pause/resume data streaming |
| Toggle Theme | Switch dark/light theme |
| Toggle Fullscreen | Enter/exit fullscreen |
| Toggle Minimap | Show/hide minimap |
| Toggle HUD | Show/hide HUD overlay |
| Zoom Extents | Fit all data in view |
| Box Zoom Mode | Activate box zoom |
| X-Axis Zoom Mode | Activate horizontal zoom |
| Y-Axis Zoom Mode | Activate vertical zoom |
| Open Series Browser | Open series management panel |
| Load Layout: [name] | Load a specific layout file |
| Reload Layout | Refresh current layout |

### 3.6 Minimap (Overview Chart)

A small navigation chart showing the full data range.

#### Features
- **Full Data Overview**: See entire dataset at a glance
- **Visible Window**: Highlighted region shows current chart viewport
- **Click to Navigate**: Click anywhere to jump to that time
- **Drag Window**: Drag the highlighted area to pan

#### Configuration
```json
// In ui-config.json
"minimap": {
  "enabled": true,
  "overlay": true,
  "liveWindowMs": 300000  // 5 minutes visible in live mode
}
```

---

## 4. Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `J` | Jump to Live (return to real-time edge) |
| `M` | Toggle Minimap visibility |
| `H` | Toggle HUD visibility |
| `T` | Toggle Theme (dark/light) |
| `F` | Toggle Fullscreen mode |
| `B` | Activate Box Zoom mode |
| `X` | Activate X-Axis Zoom mode |
| `Y` | Activate Y-Axis Zoom mode |
| `Z` | Zoom Extents (fit all data) |
| `Ctrl/Cmd+K` | Open Command Palette |
| `Escape` | Close open dialogs/palettes |

---

## 5. Chart Interactions

### 5.1 Live vs Paused Modes

#### Live Mode (Auto-Scroll ON)
- Chart automatically scrolls to show newest data
- Y-axis auto-scales to visible data
- New data appears at the right edge
- Best for monitoring real-time activity

#### Paused Mode (Auto-Scroll OFF)
- Chart stays at current position
- Free exploration of historical data
- Pan and zoom without interruption
- Data continues collecting in background
- Click "Jump to Live" (`J`) to return

**Auto-Pause Triggers:**
- Any zoom operation
- Panning the chart
- Double-clicking the chart

### 5.2 Pan (Scroll)

| Input | Action |
|-------|--------|
| Click + Drag | Pan in any direction |
| Middle Mouse Drag | Pan (alternative) |
| Touch Drag | Pan on touch devices |

### 5.3 Zoom

| Input | Action |
|-------|--------|
| Mouse Wheel | Zoom in/out at cursor position |
| Shift + Wheel | Zoom Y-axis only |
| Ctrl + Wheel | Zoom X-axis only |
| Pinch Gesture | Zoom on touch devices |
| Double-Click | Zoom extents + pause |

#### Zoom Modes
| Mode | Behavior |
|------|----------|
| **Box Zoom (B)** | Draw rectangle to zoom into |
| **X-Zoom (X)** | Horizontal selection zoom |
| **Y-Zoom (Y)** | Vertical selection zoom |

### 5.4 Axis Interactions

| Input | Action |
|-------|--------|
| Drag X-Axis | Pan horizontally |
| Drag Y-Axis | Pan vertically |
| Wheel on X-Axis | Zoom X-axis |
| Wheel on Y-Axis | Zoom Y-axis |
| Double-Click Axis | Reset that axis to auto-range |

### 5.5 Multi-Pane Behavior

- **X-Axes are Linked**: Panning/zooming X affects all panes
- **Y-Axes are Independent**: Each pane has its own Y-range
- **Cursor Syncs**: Crosshair position syncs across panes

---

## 6. Configuration Files

### 6.1 UI Configuration (`public/ui-config.json`)

This file controls application behavior, performance settings, and defaults.

```json
{
  "transport": {
    "wsUrl": "ws://127.0.0.1:8765",
    "binary": false,
    "useWorker": false,
    "autoReconnect": true,
    "useLocalStorage": false,
    "cursorPolicy": "from_start"
  },
  "ingest": {
    "targetTransferHz": 60,
    "maxPointsPerBatch": 262144
  },
  "uiDrain": {
    "maxBatchesPerFrame": 16,
    "maxMsPerFrame": 10
  },
  "data": {
    "registry": {
      "enabled": true,
      "maxRows": 5000
    },
    "buffers": {
      "pointsPerSeries": 2000000,
      "maxPointsTotal": 10000000
    }
  },
  "performance": {
    "targetFPS": 60,
    "batchSize": 5000,
    "downsampleRatio": 1,
    "maxAutoTicks": 10,
    "fifoEnabled": true,
    "fifoSweepSize": 100000,
    "updateIntervalMs": 16,
    "resamplingMode": "None",
    "resamplingPrecision": 1
  },
  "chart": {
    "separateXAxes": false,
    "autoScroll": true,
    "autoScrollThreshold": 200,
    "timezone": "America/Chicago"
  },
  "dataCollection": {
    "continueWhenPaused": true,
    "backgroundBufferSize": 10000000
  },
  "minimap": {
    "enabled": false,
    "overlay": true,
    "liveWindowMs": 300000
  },
  "ui": {
    "theme": {
      "default": "dark",
      "allowToggle": true
    },
    "autoHide": {
      "enabled": false,
      "delayMs": 3000
    },
    "timeWindowPresets": [
      { "label": "Last 15 min", "minutes": 15 },
      { "label": "Last 30 min", "minutes": 30 },
      { "label": "Last 1 hour", "minutes": 60 },
      { "label": "Last 4 hours", "minutes": 240 }
    ]
  },
  "defaultLayoutPath": "/layouts/ahmad.json"
}
```

#### Configuration Sections

##### Transport Settings
| Setting | Description | Default |
|---------|-------------|---------|
| `wsUrl` | WebSocket server URL | `ws://127.0.0.1:8765` |
| `binary` | Use binary WebSocket protocol | `false` |
| `useWorker` | Process data in Web Worker | `false` |
| `autoReconnect` | Auto-reconnect on disconnect | `true` |
| `useLocalStorage` | Persist cursor in localStorage | `false` |
| `cursorPolicy` | Resume behavior | `from_start` |

##### Performance Settings
| Setting | Description | Default |
|---------|-------------|---------|
| `targetFPS` | Target frame rate | `60` |
| `batchSize` | Points per render batch | `5000` |
| `fifoEnabled` | Use circular buffers | `true` |
| `fifoSweepSize` | Points before FIFO sweep | `100000` |
| `resamplingMode` | Data resampling | `None` |
| `updateIntervalMs` | Render interval | `16` |

##### Chart Settings
| Setting | Description | Default |
|---------|-------------|---------|
| `separateXAxes` | Independent X-axes per pane | `false` |
| `autoScroll` | Auto-scroll in live mode | `true` |
| `autoScrollThreshold` | Pixels from edge to trigger scroll | `200` |
| `timezone` | Timezone for time labels | `America/Chicago` |

##### Data Settings
| Setting | Description | Default |
|---------|-------------|---------|
| `pointsPerSeries` | Pre-allocated points per series | `2000000` |
| `maxPointsTotal` | System-wide point limit | `10000000` |
| `continueWhenPaused` | Collect data when paused | `true` |

### 6.2 Layout JSON Files

Layout files define the chart structure and are stored in `public/layouts/`.

The `defaultLayoutPath` in `ui-config.json` specifies which layout loads on startup.

---

## 7. Layout JSON Reference

### 7.1 Basic Structure

```json
{
  "layout_mode": "multi_surface",
  "grid": [2, 1],
  "panes": [
    { "id": "pane-1", "row": 0, "col": 0, "height": 1, "width": 1, "title": "Main Chart" },
    { "id": "pane-2", "row": 1, "col": 0, "height": 1, "width": 1, "title": "Indicators" }
  ],
  "series": [
    { "series_id": "ticks/MESU5", "pane": "pane-1", "type": "FastLineRenderableSeries" }
  ],
  "xAxis": {
    "defaultRange": { "mode": "lastMinutes", "value": 30 }
  },
  "minimap": {
    "source": { "series_id": "ticks/MESU5" }
  }
}
```

### 7.2 Grid Definition

```json
"grid": [rows, columns]
```

Examples:
- `[2, 1]` - 2 rows, 1 column (vertical stack)
- `[1, 2]` - 1 row, 2 columns (horizontal split)
- `[2, 2]` - 2x2 grid

### 7.3 Pane Configuration

```json
{
  "id": "unique-pane-id",
  "row": 0,
  "col": 0,
  "height": 1,
  "width": 1,
  "title": "Pane Title",
  "overlays": [
    { "type": "hline", "value": 5000.00, "color": "#FF0000", "label": "Resistance" },
    { "type": "vline", "value": 1704067200000, "color": "#00FF00", "label": "Event" }
  ]
}
```

| Field | Description |
|-------|-------------|
| `id` | Unique identifier for the pane |
| `row` | Grid row position (0-indexed) |
| `col` | Grid column position (0-indexed) |
| `height` | Number of rows to span |
| `width` | Number of columns to span |
| `title` | Display title |
| `overlays` | Array of horizontal/vertical lines |

### 7.4 Series Configuration

```json
{
  "series_id": "ticks/MESU5",
  "pane": "pane-1",
  "type": "FastLineRenderableSeries",
  "style": {
    "stroke": "#00BFFF",
    "strokeThickness": 2,
    "opacity": 1.0
  }
}
```

#### Series Types

| Type | Use For |
|------|---------|
| `FastLineRenderableSeries` | Tick data, indicators, signals |
| `FastCandlestickRenderableSeries` | OHLC bar data |
| `FastMountainRenderableSeries` | Area/mountain charts (PnL) |
| `XyScatterRenderableSeries` | Strategy markers |

#### Style Options

```json
"style": {
  "stroke": "#00BFFF",
  "strokeThickness": 2,
  "opacity": 1.0,
  "fill": "rgba(0, 191, 255, 0.3)",
  "upFillBrush": "#22C55E",
  "downFillBrush": "#EF4444",
  "upWickColor": "#22C55E",
  "downWickColor": "#EF4444"
}
```

### 7.5 Series ID Format

Series IDs from the server follow this naming convention:

| Pattern | Example | Description |
|---------|---------|-------------|
| `ticks/{instrument}` | `ticks/MESU5` | Raw tick prices |
| `sma_{period}/{instrument}` | `sma_20/MESU5` | Simple Moving Average |
| `bar_{interval}m/{instrument}` | `bar_5m/MESU5` | OHLC bars |
| `signal/{name}/{instrument}` | `signal/momentum/MESU5` | Trading signals |
| `pnl/{strategy}/{instrument}` | `pnl/strategy1/MESU5` | PnL curve |
| `marker/{type}/{strategy}/{instrument}` | `marker/entry/strategy1/MESU5` | Trade markers |

### 7.6 X-Axis Default Range

Control what time range is visible on initial load:

```json
"xAxis": {
  "defaultRange": {
    "mode": "lastMinutes",
    "value": 30
  }
}
```

#### Range Modes

| Mode | Description | Example |
|------|-------------|---------|
| `lastMinutes` | Show last N minutes | `{ "mode": "lastMinutes", "value": 30 }` |
| `lastHours` | Show last N hours | `{ "mode": "lastHours", "value": 4 }` |
| `session` | Show current trading session | `{ "mode": "session" }` |
| `entireSession` | Show full historical range | `{ "mode": "entireSession" }` |
| `custom` | Specific timestamp range | `{ "mode": "custom", "customRange": [start, end] }` |

### 7.7 Strategy Markers

Configure how strategy entry/exit markers are displayed:

```json
"strategy_markers": {
  "exclude_panes": ["ohlc-pane"],
  "consolidate": true,
  "styles": {
    "entry_long": { "color": "#22C55E", "shape": "triangle_up" },
    "exit_long": { "color": "#22C55E", "shape": "triangle_down" },
    "entry_short": { "color": "#EF4444", "shape": "triangle_down" },
    "exit_short": { "color": "#EF4444", "shape": "triangle_up" }
  }
}
```

### 7.8 Minimap Configuration

```json
"minimap": {
  "source": {
    "series_id": "ticks/MESU5"
  },
  "height": 60,
  "visible": true
}
```

---

## 8. WebSocket Server Reference

The included `server.py` provides a configurable data server for development and testing.

### 8.1 Command-Line Options

```bash
python server.py [options]
```

| Option | Description | Default |
|--------|-------------|---------|
| `--port` | WebSocket port | `8765` |
| `--host` | Bind address | `127.0.0.1` |
| `--instrument` | Instrument symbol | `MESU5` |
| `--price-model` | Price generation model | `randomwalk` |
| `--tick-rate` | Ticks per second | `100` |
| `--sma-windows` | SMA periods (comma-separated) | `10,20` |
| `--bar-intervals` | Bar intervals in minutes | `1,5` |
| `--strategies` | Strategy names | `strategy1` |
| `--initial-price` | Starting price | `5000` |
| `--volatility` | Price volatility | `0.001` |

### 8.2 Price Models

| Model | Description |
|-------|-------------|
| `randomwalk` | Random walk with drift |
| `sine` | Sinusoidal pattern |
| `step` | Step function |

### 8.3 Example Commands

```bash
# High-frequency tick data with multiple SMAs
python server.py --tick-rate 200 --sma-windows 5,10,20,50,100

# Multiple instruments (run multiple instances on different ports)
python server.py --port 8765 --instrument ESU5
python server.py --port 8766 --instrument NQU5

# Slow data for debugging
python server.py --tick-rate 1 --price-model sine

# Full strategy simulation
python server.py --strategies alpha,beta,gamma --bar-intervals 1,5,15,60
```

---

## 9. Debugging and Troubleshooting

### 9.1 Debug Panel

Access via Toolbar → Debug Panel button.

#### Tabs

| Tab | Contents |
|-----|----------|
| **Overview** | Connection status, data rates, memory usage |
| **Registry** | All known series and their point counts |
| **Signals** | Signal series data |
| **Markers** | Strategy markers |
| **PnL** | Profit/loss series |
| **Protocol** | Raw WebSocket message log |

### 9.2 Chart Logger (Browser Console)

The application exposes `chartLogger` globally for advanced debugging.

```javascript
// In browser console:

// Download all logs as JSON file
chartLogger.downloadLogs()

// Get error summary
chartLogger.getSummary()

// Download crash snapshot (if crash occurred)
chartLogger.downloadLastCrashSnapshot()

// Check WASM health status
chartLogger.getWasmHealth()

// Get recent errors
chartLogger.getRecentErrors(10)
```

### 9.3 Common Issues

#### "Waiting for Data" Message

**Symptoms**: Chart shows "Waiting for Data" overlay

**Causes & Solutions**:
1. Server not running → Start `python server.py`
2. Wrong WebSocket URL → Check `ui-config.json` or Connection Controls
3. Layout series_id mismatch → Verify layout JSON matches server output
4. Network firewall → Check port accessibility

#### Connection Failures

**Symptoms**: Status shows "ERROR" or "CONNECTING" indefinitely

**Solutions**:
1. Verify server is running: `netstat -an | grep 8765`
2. Check browser console for errors
3. Try `ws://localhost:8765` instead of `ws://127.0.0.1:8765`
4. Disable browser extensions that might block WebSocket

#### UI Freezing

**Symptoms**: Application becomes unresponsive

**Causes & Solutions**:
1. **WASM memory exhaustion** → Refresh page, reduce `pointsPerSeries`
2. **Too many series** → Hide unused series in Series Browser
3. **Minimap with too much data** → Disable minimap
4. **Browser memory limit** → Close other tabs, increase Chrome memory flags

#### Missing Data/Series

**Symptoms**: Some series don't appear on chart

**Solutions**:
1. Check Series Browser → Is series visible (checked)?
2. Verify layout JSON includes the series
3. Check series_id matches exactly (case-sensitive)
4. Open Debug Panel → Registry tab to see all known series

#### Performance Degradation Over Time

**Symptoms**: FPS drops after extended use

**Solutions**:
1. Enable FIFO mode: `"fifoEnabled": true`
2. Reduce `pointsPerSeries` allocation
3. Increase `fifoSweepSize` for smoother sweeps
4. Disable minimap if not needed

---

## 10. Performance Tips

### 10.1 Recommended Settings by Data Volume

#### Light Usage (< 100K points)
```json
{
  "performance": {
    "fifoEnabled": false,
    "batchSize": 1000,
    "resamplingMode": "None"
  },
  "data": {
    "buffers": {
      "pointsPerSeries": 100000
    }
  }
}
```

#### Standard Usage (100K - 1M points)
```json
{
  "performance": {
    "fifoEnabled": true,
    "fifoSweepSize": 50000,
    "batchSize": 5000,
    "resamplingMode": "None"
  },
  "data": {
    "buffers": {
      "pointsPerSeries": 500000
    }
  }
}
```

#### Heavy Usage (1M - 10M points)
```json
{
  "performance": {
    "fifoEnabled": true,
    "fifoSweepSize": 100000,
    "batchSize": 10000,
    "resamplingMode": "Auto"
  },
  "data": {
    "buffers": {
      "pointsPerSeries": 2000000
    }
  }
}
```

### 10.2 FIFO Mode

**What it does**: Automatically removes old data points when buffer is full

**When to enable**:
- Long-running sessions (8+ hours)
- High-frequency data (100+ ticks/second)
- Limited memory environment

**Trade-off**: Oldest data is discarded; use minimap to navigate remaining data

### 10.3 Resampling Modes

| Mode | Description | Use When |
|------|-------------|----------|
| `None` | No resampling, full fidelity | Critical data, low point count |
| `Auto` | Automatic based on zoom level | General use, good balance |
| `Min` | Show minimums | Finding lows |
| `Max` | Show maximums | Finding highs |
| `MinMax` | Show both min and max | Volatility analysis |

### 10.4 Batch Size Tuning

- **Lower values (500-1000)**: More responsive UI, higher CPU overhead
- **Higher values (5000-10000)**: Better throughput, slight UI lag
- **Recommendation**: Start at 5000, adjust based on FPS monitoring

---

## 11. Example Layouts

The `public/layouts/` directory contains ready-to-use layout examples:

| File | Description |
|------|-------------|
| `layout-single-pane.json` | Single chart with tick data |
| `layout-2x1-horizontal.json` | Two panes side by side |
| `layout-2x1-simple.json` | Two panes stacked vertically |
| `layout-2x2-grid.json` | 2x2 grid layout |
| `layout-3x3-grid.json` | 3x3 grid for multiple instruments |
| `layout-with-pnl.json` | Price chart + PnL curve |
| `layout-with-mountain.json` | Mountain (area) chart example |
| `layout-with-overlays.json` | Horizontal/vertical line overlays |
| `layout-strategy-markers.json` | Entry/exit marker visualization |
| `layout-multi-strategy-example.json` | Multiple strategies comparison |
| `layout-mesu5-full.json` | Complete MESU5 setup |
| `ahmad.json` | Production-ready full configuration |

### Loading a Layout

1. **Via Toolbar**: Click layout dropdown → Select layout
2. **Via Command Palette**: `Ctrl/Cmd+K` → Type layout name
3. **Via URL**: Add `?layout=/layouts/filename.json` to URL
4. **Set Default**: Edit `defaultLayoutPath` in `ui-config.json`

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **FIFO** | First-In-First-Out buffer that discards oldest data |
| **HUD** | Heads-Up Display showing real-time metrics |
| **OHLC** | Open-High-Low-Close candlestick data |
| **Pane** | Individual chart surface within a layout |
| **RenderableSeries** | SciChart visual representation of data |
| **SMA** | Simple Moving Average indicator |
| **WASM** | WebAssembly - SciChart's rendering engine |

---

## Appendix B: Support

### Reporting Issues

When reporting issues, include:
1. Browser and version
2. Console error messages (`chartLogger.downloadLogs()`)
3. Layout JSON file
4. Steps to reproduce
5. Expected vs actual behavior

### Getting Help

- Check Debug Panel for diagnostic information
- Review browser console for errors
- Export logs using `chartLogger.downloadLogs()`
- Verify server is sending expected data format

---

*Last Updated: January 2026*
