# Plot Layout Implementation Summary

## ✅ What Has Been Implemented

### Core Infrastructure (100% Complete)

1. **TypeScript Types** (`src/types/plot-layout.ts`)
   - Complete type definitions matching client's JSON structure
   - `PlotLayout`, `PaneConfig`, `SeriesAssignment`, `StrategyMarkersConfig`
   - `ParsedLayout` with computed maps for efficient lookups
   - `parsePlotLayout()` function with validation
   - `getDefaultLayout()` for fallback

2. **Layout Manager** (`src/lib/plot-layout-manager.ts`)
   - `PlotLayoutManager` class for managing layouts
   - Series-to-pane mapping logic
   - Strategy markers routing (excludes PnL and bar plots)
   - Pane surface registration system
   - "Waiting for Data" tracking

3. **MultiPaneChart Integration**
   - Added `plotLayout` prop support
   - Updated `DataSeriesEntry` to include `paneId` (backward compatible)
   - Integrated `PlotLayoutManager` instance
   - Created `getPaneForSeries()` helper for layout-based routing
   - Updated series creation/preallocation to use layout routing

4. **TradingChart Integration**
   - Loads default layout from `uiConfig.defaultLayout` on mount
   - Falls back to built-in default if none provided
   - Updated `handleLoadLayout()` to parse and apply layout JSON
   - Passes `plotLayout` to `useMultiPaneChart`

5. **UI Config**
   - Added `defaultLayout` section to `public/ui-config.json`

---

## ⚠️ Current Status: Bridge Implementation

The current implementation is a **bridge** that:
- ✅ Parses and validates layout JSON
- ✅ Determines which pane each series should go to
- ⚠️ **Still routes to hardcoded `tick-chart` and `ohlc-chart` containers**

This works for basic cases but doesn't support:
- ❌ True dynamic MxN grids
- ❌ Dedicated PnL plots
- ❌ Multiple panes of the same type
- ❌ Custom pane configurations

---

## 🚧 What Still Needs Implementation

### 1. Dynamic Grid Rendering (Critical)
**Status**: 0% - Not started

**What's Needed**:
- Create `DynamicPlotGrid` component that:
  - Takes `ParsedLayout` as prop
  - Dynamically creates container divs for each pane based on `grid: [rows, cols]`
  - Uses CSS Grid for layout
  - Creates `SciChartSurface` instances for each pane dynamically
  - Generates unique container IDs for each pane

**Impact**: This is the foundation for everything else. Without it, we can't have true dynamic layouts.

### 2. Pane Surface Registry
**Status**: 20% - Partial (layout manager has registry, but not connected to actual surfaces)

**What's Needed**:
- Map `paneId` to actual `SciChartSurface` instances in `MultiPaneChart`
- Update `getPaneForSeries()` to return actual surfaces from registry
- Support dynamic pane creation/destruction when layout changes

### 3. Dedicated PnL Plot
**Status**: 10% - Layout manager knows about PnL, but no dedicated surface

**What's Needed**:
- Create separate `SciChartSurface` for PnL when layout specifies it
- Handle PnL-specific Y-axis scaling
- Route PnL series to PnL pane only

### 4. Strategy Markers Routing
**Status**: 30% - Layout manager determines which panes should show markers

**What's Needed**:
- Actually render strategy markers on multiple panes
- Use timestamp for non-tick plots
- Consolidate markers by type (as per requirements)

### 5. Hlines/Vlines Overlays
**Status**: 0% - Not started

**What's Needed**:
- Render horizontal lines as SciChart annotations
- Render vertical lines as SciChart annotations
- Apply styles from layout JSON (`strokeDashArray`, `stroke`, etc.)

### 6. "Waiting for Data" Messages
**Status**: 30% - Layout manager tracks state, but no UI

**What's Needed**:
- Create UI component to display "Waiting for Data..." message
- Integrate with pane rendering
- Show message when `waitingForData === true`

### 7. Mid-Run Layout Loading
**Status**: 40% - Layout can be loaded, but series aren't moved

**What's Needed**:
- Preserve existing `DataSeries` when layout changes
- Move series between panes (remove from old surface, add to new surface)
- Cleanup unused panes when layout changes
- Handle X-axis synchronization when panes change

---

## 📊 Overall Completion

| Feature | Status | Completion |
|---------|--------|------------|
| Core Infrastructure | ✅ | 100% |
| Layout Parsing | ✅ | 100% |
| Series-to-Pane Mapping | ⚠️ | 60% (bridge implementation) |
| Dynamic Grid | ❌ | 0% |
| PnL Dedicated Plot | ❌ | 10% |
| Strategy Markers | ⚠️ | 30% |
| Overlays (Hlines/Vlines) | ❌ | 0% |
| "Waiting for Data" | ⚠️ | 30% |
| Mid-Run Loading | ⚠️ | 40% |

**Overall**: ~35% complete

---

## 🎯 Next Steps (Priority Order)

1. **Create `DynamicPlotGrid` Component** (Critical Path)
   - This unlocks all other features
   - Enables true dynamic layouts
   - Foundation for everything else

2. **Implement Pane Surface Registry**
   - Connect layout manager to actual SciChart surfaces
   - Enable proper series-to-pane routing

3. **Add "Waiting for Data" UI**
   - Simple overlay component
   - Shows when pane has no data

4. **Implement Overlays**
   - Hlines/Vlines as annotations
   - Relatively straightforward

5. **Strategy Markers**
   - Multi-pane rendering
   - Timestamp-based plotting

6. **Mid-Run Layout Changes**
   - Data preservation
   - Series movement
   - Pane cleanup

---

## 🔍 How It Works Now

### Current Flow:

1. **Layout Loading**:
   - `TradingChart` loads default layout from `ui-config.json` on mount
   - User can load custom layout via `handleLoadLayout()`
   - Layout is parsed and validated by `parsePlotLayout()`

2. **Series Routing**:
   - `MultiPaneChart` receives `plotLayout` prop
   - `getPaneForSeries()` uses layout manager to determine pane
   - **Currently**: Maps paneId to existing tick/ohlc surfaces via string matching
   - **Future**: Will map to actual dynamic surfaces from registry

3. **Series Creation**:
   - `ensureSeriesExists()` and registry preallocation use `getPaneForSeries()`
   - Series are created with `paneId` in `DataSeriesEntry`
   - Series are added to the appropriate surface

4. **Limitations**:
   - Only works with 2-pane layouts (tick + ohlc)
   - PnL routes to tick chart (not dedicated)
   - No overlays rendered
   - No "Waiting for Data" UI

---

## 📝 Notes

- The current implementation is **backward compatible** - it still works with the old hardcoded routing if no layout is provided
- The bridge implementation allows testing of layout parsing and routing logic before implementing full dynamic grids
- All series routing now goes through `getPaneForSeries()`, making it easy to switch to dynamic surfaces later




