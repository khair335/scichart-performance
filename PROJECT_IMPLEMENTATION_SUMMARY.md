# Project Implementation Summary

## Overview
This document provides a comprehensive summary of the current implementation of the SciChart.js real-time trading chart application. The project is a high-performance, real-time data visualization system designed for market data with support for multiple chart types, dynamic series discovery, and extensive configuration options.

---

## 1. Architecture & Core Components

### 1.1 Main Application Structure
- **Entry Point**: `src/pages/Index.tsx`
  - Loads configuration files (`config.json` and `ui-config.json`) on startup
  - Initializes the `TradingChart` component with WebSocket URL and UI configuration
  - Handles loading states and error handling

- **Main Chart Component**: `src/components/chart/TradingChart.tsx`
  - Orchestrates all chart-related components
  - Manages state for: theme, minimap, series visibility, live mode, FPS, data clock, performance metrics
  - Integrates WebSocket feed and demo data generator
  - Provides UI controls: Toolbar, HUD, Series Browser, Command Palette

### 1.2 Core Chart Engine
- **Multi-Pane Chart Hook**: `src/components/chart/MultiPaneChart.tsx`
  - Central chart rendering and data processing engine
  - Manages two chart surfaces: Tick Price & Indicators, OHLC Candlesticks
  - Implements unified DataSeries store for dynamic series management
  - Handles real-time data ingestion, batching, and rendering
  - ~2,500 lines of optimized chart logic

### 1.3 Data Pipeline

#### WebSocket Client (`src/lib/wsfeed-client.ts`)
- Universal WebSocket feed client for real-time data
- Handles connection lifecycle, reconnection, and error recovery
- Implements sequence number deduplication
- Manages feed stages: `idle`, `history`, `delta`, `live`
- Tracks data registry with metadata (count, first/last timestamps, gaps, missed samples)
- Provides status updates with history progress, rate metrics, heartbeat lag

#### Data Processing Flow
```
WebSocket Server → WS Client (feed) → Sample Buffer → Batch Processing → DataSeries Store → Chart Rendering
```

- **Sample Buffer**: Preallocated circular buffer (configurable size, default 10M samples)
- **Batch Processing**: Configurable batch size (default 500 samples) with downsampling (default 2:1 ratio)
- **DataSeries Store**: Unified `Map<string, DataSeriesEntry>` for all series
- **Background Collection**: Continues collecting data even when charts are paused

---

## 2. Data Series Management

### 2.1 Unified DataSeries Store
- **Structure**: `Map<string, DataSeriesEntry>`
  - Key: `series_id` (e.g., `MESU5:ticks`, `MESU5:sma_10`)
  - Value: `DataSeriesEntry` containing:
    - `dataSeries`: `XyDataSeries` or `OhlcDataSeries`
    - `renderableSeries`: `FastLineRenderableSeries` or `FastCandlestickRenderableSeries`
    - `chartTarget`: `'tick'` | `'ohlc'`
    - `seriesType`: `'tick'` | `'ohlc-bar'` | `'tick-indicator'` | `'bar-indicator'` | `'strategy-marker'` | `'strategy-signal'` | `'strategy-pnl'`

### 2.2 Series Namespace & Discovery
- **Namespace Parser**: `src/lib/series-namespace.ts`
  - Parses `series_id` to determine type and chart target
  - Supports patterns:
    - Tick: `ES.c.0:ticks`
    - Tick indicators: `ES.c.0:sma_10`, `ES.c.0:vwap`
    - OHLC bars: `ES.c.0:ohlc_time:10000`
    - Bar indicators: `ES.c.0:ohlc_time:10000:rsi`
    - Strategy: `ES.c.0:strategy:alpha:markers`, `ES.c.0:strategy:alpha:pnl`
  - Dynamically routes series to correct chart (tick or OHLC)
  - No hardcoded assumptions about indicator types

### 2.3 Preallocation & On-Demand Creation
- **Registry-Based Preallocation**: 
  - When registry updates, preallocates `DataSeries` for discovered series
  - Uses `fifoCapacity` from UI config (default 1,000,000 points per series)
  - Creates both `DataSeries` and `RenderableSeries` with appropriate styling
  
- **On-Demand Fallback**:
  - If data arrives before registry preallocation, creates series on-demand
  - Ensures no data is skipped
  - Logs creation for debugging

### 2.4 Series Visibility Management
- **Visibility State**: `Set<string>` tracking visible series IDs
- **Dynamic Updates**: `useEffect` syncs visibility state with `renderableSeries.isVisible`
- **Y-Axis Preservation**: Saves and restores Y-axis ranges when toggling visibility to prevent scaling issues
- **Initial State**: All discovered series visible by default (except strategy series which are hidden by default)

---

## 3. Chart Configuration & Performance

### 3.1 UI Configuration File (`public/ui-config.json`)
```json
{
  "transport": { "wsUrl": "...", "binary": false, "useWorker": false },
  "ingest": { "targetTransferHz": 20, "maxPointsPerBatch": 131072 },
  "uiDrain": { "maxBatchesPerFrame": 8, "maxMsPerFrame": 6 },
  "data": {
    "registry": { "enabled": true, "maxRows": 5000 },
    "buffers": { "pointsPerSeries": 1000000, "maxPointsTotal": 10000000 }
  },
  "performance": {
    "targetFPS": 60,
    "batchSize": 500,
    "downsampleRatio": 2,
    "maxAutoTicks": 8
  },
  "chart": {
    "separateXAxes": true,
    "autoScroll": true,
    "autoScrollThreshold": 200,
    "timezone": "UTC"
  },
  "dataCollection": {
    "continueWhenPaused": true,
    "backgroundBufferSize": 10000000
  },
  "minimap": { "enabled": false, "overlay": true, "liveWindowMs": 300000 },
  "ui": { "theme": { "default": "dark", "allowToggle": true } }
}
```

### 3.2 Performance Optimizations

#### Downsampling
- **Base Ratio**: 2:1 (configurable via `ui-config.json`)
- **Resampling Modes**:
  - Tick series: `EResamplingMode.None` (no resampling for smooth sine waves)
  - Indicator series: `EResamplingMode.Auto` (automatic resampling)
  - OHLC bars: `EResamplingMode.Auto`

#### Batching
- **Batch Size**: 500 samples per frame (configurable)
- **Buffer Size**: 10M samples background buffer (configurable)
- **Processing**: Uses `requestAnimationFrame` when visible, `setTimeout` when hidden

#### Rendering Optimizations
- `useNativeText`: Enabled for better text rendering performance
- `useSharedCache`: Enabled for shared rendering cache
- `DpiHelper.IsDpiScaleEnabled`: Disabled to prevent scaling issues
- Throttled Y-axis updates: 200ms interval
- X-axis scroll threshold: 200ms (configurable)

---

## 4. Chart Features

### 4.1 Multi-Pane Layout
- **Tick Price & Indicators Chart**:
  - Primary chart for tick data and tick-based indicators
  - Supports: tick prices, SMA, VWAP, EMA, and other tick indicators
  - Strategy markers, signals, and PnL
  
- **OHLC Candlesticks Chart**:
  - Secondary chart for OHLC bar data
  - Supports: OHLC bars with various intervals
  - Bar-based indicators (e.g., RSI on OHLC bars)

### 4.2 X-Axis Management

#### Separate X-Axes
- Each pane has its own X-axis (configurable via `separateXAxes`)
- Can be linked via `SciChartVerticalGroup` if `separateXAxes: false`
- Default: Separate axes enabled

#### Auto-Scroll in Live Mode
- **Window Size**: 2 minutes (fixed for live mode)
- **Range Calculation**: Always uses actual data from DataSeries, not future timestamps
- **Update Logic**:
  - Forces update if data is outside visible range
  - Forces update if data is significantly ahead of current range
  - Forces update if range is too wide (showing old history)
  - Uses threshold (200ms) for smooth scrolling when data is within range

#### History Loading
- **No Scrolling**: X-axis range is NOT updated during history/delta loading
- **Live Transition**: When transitioning to live, waits for data processing to complete, then sets range to show latest 2 minutes of data
- **Data Verification**: Ensures `actualDataMax` is from DataSeries, not `lastDataTimeRef` (which might be future timestamp)

### 4.3 Y-Axis Auto-Scaling
- **Mode**: `EAutoRange.Once` (scales once, then manual updates)
- **Live Transition**: Automatically scales Y-axis when entering live mode
- **Retry Mechanism**: Up to 5 attempts with exponential backoff (100ms, 200ms, 400ms, 800ms, 1600ms)
- **Fallback**: Manual Y-range calculation if `zoomExtentsY()` fails
- **Visibility Preservation**: Y-axis ranges preserved when toggling series visibility

### 4.4 Chart Modifiers
- `MouseWheelZoomModifier`: Zoom with mouse wheel
- `RubberBandXyZoomModifier`: Drag to zoom (box selection)
- `ZoomExtentsModifier`: Double-click to fit all data
- `CursorModifier`: Show crosshair and data values
- `RolloverModifier`: Show tooltips on hover
- `XAxisDragModifier` / `YAxisDragModifier`: Drag axes to pan

---

## 5. User Interface Components

### 5.1 Heads-Up Display (HUD)
- **Metrics Displayed**:
  - FPS (Frames Per Second)
  - Data Rate (samples/second)
  - Lag (milliseconds)
  - Tick Count
  - CPU Usage (%)
  - Memory Usage (MB)
  - GPU Metrics (draw calls, triangles)
  - Feed Stage (history/delta/live)
  - History Progress (%)
  - Data Clock (latest timestamp)

### 5.2 Toolbar
- Live/Pause toggle
- Zoom controls
- Minimap toggle
- Series browser toggle
- Theme toggle (dark/light)
- Command palette shortcut (Ctrl/Cmd+K)

### 5.3 Series Browser
- **Drawer Component**: Slide-out panel for series management
- **Features**:
  - Lists all discovered series grouped by type (Tick, Indicator, OHLC, Strategy)
  - Toggle visibility for each series
  - "Select All" and "Clear All" buttons
  - Shows series metadata (count, first/last timestamps)
  - Dynamic icon and type detection based on namespace parsing

### 5.4 Command Palette
- **Keyboard Shortcut**: Ctrl/Cmd+K
- **Features**:
  - Fuzzy search for commands
  - Quick actions:
    - Jump to Live
    - Toggle Live
    - Zoom Extents
    - Toggle Minimap
    - Toggle Theme
    - Load Layout
    - Open Series Browser

### 5.5 Minimap (Overview Chart)
- **Status**: Disabled by default (configurable)
- **Features** (when enabled):
  - Overlay mode
  - Live window: 5 minutes (300,000ms)
  - Shows full data range with current viewport indicator

---

## 6. Data Collection & Background Processing

### 6.1 Continuous Data Collection
- **Background Buffer**: Always collects data regardless of chart state
- **Buffer Size**: 10M samples (configurable via `backgroundBufferSize`)
- **Paused Mode**: Data continues to be collected even when charts are paused
- **No Data Loss**: All incoming samples are buffered, even if processing is delayed

### 6.2 Tab Visibility Handling
- **When Hidden**: 
  - Switches from `requestAnimationFrame` to `setTimeout(16ms)` for continuous processing
  - Continues auto-scrolling X-axis to keep range current
  - Logs updates for debugging
  
- **When Visible**:
  - Switches back to `requestAnimationFrame`
  - Waits for data processing to complete
  - Sets X-axis range to latest data point (global data clock)
  - Prevents auto-scroll interference during restoration (1.5s grace period)

### 6.3 Global Data Clock
- **Definition**: Maximum `lastMs` across all registry entries
- **Usage**: 
  - Source of truth for latest data timestamp
  - Used for X-axis range calculation when tab becomes visible
  - Ensures range matches actual data position, not future timestamps

---

## 7. Error Handling & Resilience

### 7.1 WASM Memory Management
- **Try-Catch Blocks**: All data appending wrapped in try-catch
- **Error Recovery**: Clears buffer and logs warning on memory errors
- **Data Validation**: Checks for NaN values before appending

### 7.2 Connection Resilience
- **WebSocket Reconnection**: Automatic reconnection on disconnect
- **Sequence Deduplication**: Prevents duplicate data processing
- **Status Tracking**: Monitors connection health, heartbeat lag, gaps, missed samples

### 7.3 Data Validation
- **Range Checks**: Validates X-axis ranges before setting
- **Data Existence**: Checks if data exists before scaling Y-axis
- **Timestamp Verification**: Warns if data timestamps don't match expectations

---

## 8. Configuration & Customization

### 8.1 Startup Configuration (`config.json`)
- WebSocket URL
- Theme preference
- Performance settings
- Minimap settings
- Default layout

### 8.2 UI Configuration (`ui-config.json`)
- **Transport**: WebSocket settings, binary mode, worker usage
- **Ingest**: Target transfer rate, max points per batch
- **UI Drain**: Max batches per frame, max milliseconds per frame
- **Data**: Registry settings, buffer sizes
- **Performance**: Target FPS, batch size, downsampling ratio
- **Chart**: X-axis separation, auto-scroll settings, timezone
- **Data Collection**: Background collection settings
- **Minimap**: Enable/disable, overlay mode, live window
- **UI Theme**: Default theme, toggle capability

### 8.3 Layout Loading
- **JSON Layout Support**: Can load plot layouts from JSON files
- **Dynamic Pane Configuration**: Supports changing pane layouts without losing data
- **Series Mapping**: Maps layout series to discovered series

---

## 9. Performance Monitoring

### 9.1 Metrics Collection
- **FPS**: Calculated using `performance.now()` and frame counting
- **CPU Usage**: Estimated using `performance.memory` and `requestIdleCallback`
- **Memory Usage**: From `performance.memory.usedJSHeapSize`
- **GPU Metrics**: Estimated draw calls based on visible series count
- **Data Rate**: Samples per second from WebSocket feed
- **Lag**: Heartbeat lag from WebSocket feed

### 9.2 Logging
- **Console Logging**: Extensive logging for debugging
  - Data processing status
  - X-axis range updates
  - Y-axis scaling attempts
  - Series creation/preallocation
  - Auto-scroll updates
  - Tab visibility changes
  - Error conditions

---

## 10. Key Implementation Details

### 10.1 Data Processing Pipeline
1. **WebSocket Receives Data** → Samples added to `sampleBufferRef`
2. **Batch Processing** → Samples grouped by `series_id` into `seriesBuffers` map
3. **Downsampling** → Applied based on `downsampleRatio` (default 2:1)
4. **DataSeries Append** → Data appended to appropriate `DataSeries` in unified store
5. **Rendering** → SciChart renders updated series

### 10.2 Series Lifecycle
1. **Discovery**: Series discovered via registry updates or incoming data
2. **Preallocation**: `DataSeries` created with `fifoCapacity` from config
3. **Rendering**: `RenderableSeries` added to appropriate chart surface
4. **Visibility**: Controlled via `visibleSeries` Set
5. **Data Appending**: Data always appended, visibility controls rendering

### 10.3 X-Axis Range Management
1. **History Loading**: No X-axis updates (prevents scrolling)
2. **Live Transition**: Wait for data processing → Set range to latest 2 minutes
3. **Auto-Scroll**: Check if data outside range → Force update if needed
4. **Tab Visibility**: Restore range to latest data when tab becomes visible

### 10.4 Y-Axis Scaling
1. **Initial**: `EAutoRange.Once` scales on first render
2. **Live Transition**: `zoomExtentsY()` called with retries
3. **Manual Updates**: Throttled to 200ms intervals
4. **Visibility Changes**: Ranges preserved to prevent scaling issues

---

## 11. Current Limitations & Known Issues

### 11.1 Performance
- FPS target: 50-60 FPS (may drop with many visible series)
- Downsampling: 2:1 ratio for tick data (may cause slight quality loss)
- Batch size: 500 samples (may need adjustment for very high data rates)

### 11.2 Features
- Minimap: Disabled by default (can be enabled via config)
- Web Workers: Not currently used (discussed but not implemented)
- Layout Loading: JSON layout loading implemented but may need refinement

### 11.3 Data Handling
- Large History: May take time to process when transitioning to live
- X-Axis Range: Fixed 2-minute window in live mode (may need to be configurable)
- Y-Axis Scaling: May fail with very large history (has retry mechanism)

---

## 12. File Structure

```
src/
├── components/
│   └── chart/
│       ├── MultiPaneChart.tsx      # Core chart engine (~2,500 lines)
│       ├── TradingChart.tsx        # Main chart component
│       ├── HUD.tsx                 # Heads-up display
│       ├── Toolbar.tsx             # Toolbar controls
│       ├── SeriesBrowser.tsx       # Series visibility drawer
│       ├── CommandPalette.tsx     # Command palette
│       └── ChartPane.tsx           # Individual pane component
├── lib/
│   ├── wsfeed-client.ts            # WebSocket feed client
│   ├── series-namespace.ts         # Series type parsing
│   └── utils.ts                    # Utility functions
├── hooks/
│   ├── useWebSocketFeed.ts         # WebSocket feed hook
│   └── useDemoDataGenerator.ts     # Demo data generator
├── pages/
│   └── Index.tsx                   # Application entry point
└── types/
    └── chart.ts                    # Type definitions

public/
├── config.json                     # Startup configuration
└── ui-config.json                  # UI configuration
```

---

## 13. Testing & Verification

### 13.1 Test Scenarios Covered
- History loading (no scrolling)
- Delta loading (no scrolling)
- Live mode transition (X-axis and Y-axis scaling)
- Tab visibility (background processing, range restoration)
- Series visibility toggling (Y-axis preservation)
- Large history data (adaptive window sizing)
- Manual zoom (auto-scroll to latest data)
- Multiple series types (tick, OHLC, indicators, strategy)

### 13.2 Known Working Features
✅ Real-time data streaming
✅ Dynamic series discovery
✅ Preallocation and on-demand series creation
✅ Background data collection
✅ Tab visibility handling
✅ X-axis auto-scroll
✅ Y-axis auto-scaling
✅ Series visibility management
✅ Performance monitoring
✅ Error handling and recovery

---

## 14. Summary

This implementation provides a comprehensive, high-performance real-time charting solution with:

- **Unified DataSeries Store**: Dynamic series management without hardcoded assumptions
- **Robust Data Pipeline**: Continuous data collection with background processing
- **Smart X-Axis Management**: Always shows latest data, handles history loading gracefully
- **Performance Optimizations**: Downsampling, batching, throttling for 50-60 FPS
- **Extensive Configuration**: JSON-based configuration for all aspects
- **User-Friendly UI**: HUD, Toolbar, Series Browser, Command Palette
- **Resilient Error Handling**: WASM memory management, connection recovery, data validation

The system is production-ready with extensive logging, error handling, and performance monitoring capabilities.




