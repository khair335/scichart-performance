# Plot Layout Implementation Progress

## ✅ Completed

### 1. TypeScript Interfaces (`src/types/plot-layout.ts`)
- ✅ `PlotLayout` interface matching client's JSON structure
- ✅ `PaneConfig`, `SeriesAssignment`, `StrategyMarkersConfig` interfaces
- ✅ `ParsedLayout` interface with computed maps
- ✅ `parsePlotLayout()` function for validation and parsing
- ✅ `getDefaultLayout()` function for fallback layout

### 2. Layout Manager (`src/lib/plot-layout-manager.ts`)
- ✅ `PlotLayoutManager` class for managing layouts
- ✅ Series-to-pane mapping logic
- ✅ Strategy markers routing logic (excludes PnL and bar plots by default)
- ✅ Pane surface registration
- ✅ "Waiting for Data" tracking

### 3. MultiPaneChart Integration
- ✅ Added `plotLayout` prop to `MultiPaneChartProps`
- ✅ Updated `DataSeriesEntry` to include `paneId` (backward compatible with `chartTarget`)
- ✅ Integrated `PlotLayoutManager` instance
- ✅ Created `getPaneForSeries()` helper function
- ✅ Updated `ensureSeriesExists()` to use layout-based routing
- ✅ Updated registry preallocation to use layout-based routing

### 4. TradingChart Integration
- ✅ Added `plotLayout` state
- ✅ Load default layout from `uiConfig.defaultLayout` on mount
- ✅ Fallback to built-in default layout if none provided
- ✅ Updated `handleLoadLayout()` to parse and apply layout JSON
- ✅ Pass `plotLayout` to `useMultiPaneChart`

### 5. UI Config
- ✅ Added `defaultLayout` to `public/ui-config.json`

---

## 🚧 In Progress / Partial

### 6. Dynamic Grid Rendering
- ⚠️ **Current Status**: Layout manager determines pane assignment, but still routes to hardcoded `tick-chart` and `ohlc-chart` containers
- ⚠️ **Needed**: Dynamic creation of `SciChartSurface` instances based on layout grid
- ⚠️ **Needed**: CSS Grid layout for MxN panes
- ⚠️ **Needed**: Container ID generation for each pane

**Current Bridge Implementation**:
- `getPaneForSeries()` maps paneId to existing surfaces (tick/ohlc) based on pane name matching
- This works for basic cases but doesn't support true dynamic grids

---

## ❌ Not Yet Implemented

### 7. Dedicated PnL Plot
- ❌ PnL currently routes to tick chart as fallback
- ❌ Need to create separate `SciChartSurface` for PnL when layout specifies it
- ❌ Need to handle PnL-specific Y-axis scaling

### 8. Strategy Markers Routing
- ⚠️ **Partial**: Layout manager determines which panes should show markers
- ❌ **Missing**: Actual rendering of strategy markers on multiple panes
- ❌ **Missing**: Timestamp-based plotting for non-tick plots

### 9. Hlines/Vlines Overlays
- ❌ Not implemented
- ❌ Need to render horizontal lines as SciChart annotations
- ❌ Need to render vertical lines as SciChart annotations
- ❌ Need to apply styles from layout JSON

### 10. "Waiting for Data" Messages
- ⚠️ **Partial**: Layout manager tracks `waitingForData` state
- ❌ **Missing**: UI component to display "Waiting for Data..." message
- ❌ **Missing**: Integration with pane rendering

### 11. Mid-Run Layout Loading
- ⚠️ **Partial**: Layout can be loaded and parsed
- ❌ **Missing**: Preserve existing DataSeries when changing layouts
- ❌ **Missing**: Move series between panes when layout changes
- ❌ **Missing**: Cleanup of old panes when layout changes

---

## 🔧 Implementation Strategy

### Phase 1: Dynamic Grid Component (Next Step)
Create a new component `DynamicPlotGrid` that:
1. Takes `ParsedLayout` as prop
2. Dynamically creates container divs for each pane based on grid
3. Creates `SciChartSurface` instances for each pane
4. Uses CSS Grid for layout
5. Renders "Waiting for Data" messages when needed

### Phase 2: Pane Management
1. Create `PaneSurface` registry in `MultiPaneChart`
2. Map `paneId` to actual `SciChartSurface` instances
3. Update `getPaneForSeries()` to return actual surfaces
4. Support dynamic pane creation/destruction

### Phase 3: Overlays
1. Add horizontal line annotations to panes
2. Add vertical line annotations to panes
3. Apply styles from layout JSON

### Phase 4: Strategy Markers
1. Render strategy markers on all eligible panes
2. Use timestamp for non-tick plots
3. Consolidate markers by type (as per requirements)

### Phase 5: Mid-Run Layout Changes
1. Preserve DataSeries when layout changes
2. Move series between panes
3. Cleanup unused panes

---

## 📝 Current Limitations

1. **Hardcoded Containers**: Still uses `tick-chart` and `ohlc-chart` divs instead of dynamic grid
2. **Pane Mapping**: `getPaneForSeries()` uses string matching (e.g., `paneId.includes('tick')`) instead of actual pane registry
3. **No Dynamic Surfaces**: Cannot create new `SciChartSurface` instances on the fly
4. **No Overlays**: Hlines/Vlines not rendered
5. **No "Waiting for Data" UI**: Message tracking exists but no UI component

---

## 🎯 Next Steps

1. **Create `DynamicPlotGrid` component** - This is the foundation for everything else
2. **Refactor `MultiPaneChart`** to use dynamic panes instead of hardcoded tick/ohlc
3. **Add overlay rendering** for hlines/vlines
4. **Add "Waiting for Data" UI** component
5. **Implement strategy markers** routing and rendering
6. **Test mid-run layout loading** with data preservation

---

## 📊 Completion Status

- **Core Infrastructure**: 80% ✅
- **Dynamic Grid**: 0% ❌
- **Overlays**: 0% ❌
- **Strategy Markers**: 20% ⚠️
- **Waiting for Data**: 30% ⚠️
- **Mid-Run Loading**: 40% ⚠️

**Overall**: ~35% complete




