# Plot Layout Implementation Status

## Current Implementation

### How Series Are Currently Routed to Plots

**Current Method**: Uses `series-namespace.ts` to determine chart target based on `series_id` pattern:

1. **Tick Chart** (`chartTarget: 'tick'`):
   - Tick data: `ES.c.0:ticks`
   - Tick indicators: `ES.c.0:sma_10`, `ES.c.0:vwap`
   - Strategy markers: `ES.c.0:strategy:alpha:markers`
   - Strategy signals: `ES.c.0:strategy:alpha:signals`
   - Strategy PnL: `ES.c.0:strategy:alpha:pnl` (currently goes to tick chart)

2. **OHLC Chart** (`chartTarget: 'ohlc'`):
   - OHLC bars: `ES.c.0:ohlc_time:10000`
   - Bar indicators: `ES.c.0:ohlc_time:10000:rsi`

**Problem**: This is **hardcoded routing** - it doesn't use plot layout JSON to determine placement.

---

## Client Requirements (NOT YET IMPLEMENTED)

### 1. **Plot Layout JSON File Must Control Everything**

The client requires:
- **Grid size**: Layout JSON determines grid (1x1, 2x2, 3x3, MxN)
- **Series placement**: Layout JSON determines which series goes to which cell
- **Hlines/Vlines**: Layout JSON determines overlays
- **Strategy markers**: Layout JSON determines which plots get markers (all except PnL and bar plots)
- **PnL**: Must have its own dedicated plot (not on tick chart)

### 2. **Current Layout Loading**

**Location**: `src/components/chart/TradingChart.tsx` (lines 304-348)

**What it does**:
- Loads JSON file from file picker
- Parses `layout.panes[].series[].seriesId`
- Sets `visibleSeries` based on layout

**What it DOESN'T do**:
- ❌ Doesn't create grid/panes dynamically
- ❌ Doesn't handle grid size (currently hardcoded 2 panes)
- ❌ Doesn't create new chart surfaces based on layout
- ❌ Doesn't handle hlines/vlines
- ❌ Doesn't handle strategy marker placement
- ❌ Doesn't show "Waiting for Data" messages
- ❌ Doesn't load default layout from UI config

### 3. **Current Chart Structure**

**Hardcoded**: Only 2 chart surfaces:
- `tick-chart` (Tick Price & Indicators)
- `ohlc-chart` (OHLC Candlesticks)

**Missing**:
- ❌ Dynamic grid creation (MxN panes)
- ❌ PnL dedicated plot
- ❌ Per-pane series assignment
- ❌ Hlines/Vlines rendering
- ❌ Strategy marker routing based on layout

---

## What Needs to Be Implemented

### 1. **Plot Layout JSON Structure** (Based on Client Example)

```typescript
interface PlotLayout {
  layout_mode: 'multi_surface';
  grid: [number, number]; // [rows, cols] e.g., [2, 2] for 2x2 grid
  minimap: {
    source: {
      series_id: string;
      yField: string;
    };
  };
  panes: Array<{
    id: string;
    row: number;
    col: number;
    height: number;
    width: number;
    title?: string; // Plot title
    overlays?: {
      hline?: Array<{
        id: string;
        y: number;
        label: string;
        style?: { strokeDashArray?: number[] };
      }>;
      vline?: Array<{
        id: string;
        x: number;
        label: string;
        style?: { strokeDashArray?: number[] };
      }>;
    };
  }>;
  series: Array<{
    series_id: string;
    pane: string; // Pane ID
    type: 'FastLineRenderableSeries' | 'FastCandlestickRenderableSeries';
  }>;
  strategy_markers?: {
    // Which panes should show strategy markers
    exclude_panes?: string[]; // e.g., ['pnl-pane', 'bar-pane']
    // Or explicitly list which panes should show markers
    include_panes?: string[];
  };
  meta?: {
    version: string;
  };
}
```

### 2. **Required Features**

#### A. **Dynamic Grid Creation**
- Create MxN grid of chart surfaces based on `layout.grid`
- Each pane is a separate `SciChartSurface`
- Grid layout using CSS Grid or Flexbox

#### B. **Series-to-Pane Assignment**
- Read `layout.series[]` to determine which series goes to which pane
- Move series between panes when layout changes
- Don't lose data when changing layouts

#### C. **PnL Dedicated Plot**
- PnL must have its own plot (not on tick chart)
- PnL plot should be specified in layout JSON

#### D. **Strategy Markers Routing**
- Strategy markers go to all plots EXCEPT PnL and bar plots
- Layout JSON should specify which panes get markers
- Use timestamp to plot markers on non-tick plots

#### E. **Hlines/Vlines**
- Render horizontal lines (`hline`) and vertical lines (`vline`) as overlays
- Use SciChart annotations or custom renderable series

#### F. **Default Layout from UI Config**
- Load default layout from `ui-config.json` at cold start
- If no default layout, show empty grid or "Waiting for Layout" message

#### G. **"Waiting for Data" Messages**
- Show "Waiting for Data..." message in panes that don't have data yet
- Don't crash if data hasn't arrived
- Auto-populate when data arrives

#### H. **Cold-Start and Mid-Run Loading**
- Same pipeline for both cold-start and mid-run layout loading
- Always read plot layout to create plots
- Reuse existing DataSeries when changing layouts

---

## Implementation Plan

### Phase 1: Layout JSON Parser
1. Create TypeScript interfaces for layout structure
2. Parse layout JSON file
3. Validate layout structure

### Phase 2: Dynamic Grid System
1. Create grid container component
2. Dynamically create `SciChartSurface` instances for each pane
3. Handle grid sizing (MxN)

### Phase 3: Series-to-Pane Mapping
1. Map series to panes based on layout
2. Move series between panes when layout changes
3. Preserve DataSeries when changing layouts

### Phase 4: PnL Dedicated Plot
1. Create separate PnL plot
2. Route PnL series to PnL plot only
3. Update layout JSON structure

### Phase 5: Strategy Markers
1. Parse strategy marker configuration from layout
2. Route markers to appropriate panes (exclude PnL and bar plots)
3. Use timestamp for non-tick plots

### Phase 6: Overlays (Hlines/Vlines)
1. Render horizontal lines as annotations
2. Render vertical lines as annotations
3. Apply styles from layout JSON

### Phase 7: Default Layout & "Waiting for Data"
1. Load default layout from UI config
2. Show "Waiting for Data" messages
3. Handle missing data gracefully

---

## Current vs Required

| Feature | Current | Required |
|---------|---------|----------|
| Grid size | Hardcoded 2 panes | Dynamic MxN from layout JSON |
| Series routing | Hardcoded by namespace | Layout JSON determines placement |
| PnL plot | Goes to tick chart | Must have own dedicated plot |
| Strategy markers | Goes to tick chart | All plots except PnL and bar plots |
| Hlines/Vlines | Not implemented | From layout JSON overlays |
| Default layout | Not implemented | From UI config JSON |
| "Waiting for Data" | Not implemented | Show message if no data |
| Layout loading | Basic (only visibility) | Full grid/panes/series assignment |

---

## Status: **NOT IMPLEMENTED**

The current implementation uses **hardcoded routing** based on series namespace patterns. The client requires **layout-driven routing** where the plot layout JSON file completely controls:

1. Grid structure
2. Series placement
3. Overlays
4. Strategy marker placement
5. PnL plot assignment

**This is a major feature that needs to be implemented.**




