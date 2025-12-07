# Plot Layout Implementation TODO

## Overview

Dynamic plot layout system where layout JSON controls grid structure, series placement, overlays, strategy markers, and PnL plot assignment.

**Current Status**: ~35% complete

---

## ✅ Completed

1. ✅ TypeScript type definitions for layout structure
2. ✅ Layout manager class with series-to-pane mapping
3. ✅ Layout parsing and validation
4. ✅ Basic chart integration (bridge implementation)
5. ✅ Default layout loading from config

---

## 🔴 CRITICAL - Must Complete First

### 1. Dynamic Grid Rendering Component
**Status**: ❌ 0% - Not Started  
**Priority**: 🔴 CRITICAL - Blocks all other features

**Requirements**:
- Create component that renders MxN grid based on layout JSON `grid: [rows, cols]`
- Dynamically create container divs for each pane
- Use CSS Grid for layout
- Respect pane `row`, `col`, `height`, `width` properties
- Generate unique container IDs for each pane
- Create `SciChartSurface` instances for each pane dynamically
- Register surfaces with layout manager
- Handle surface cleanup on unmount/layout change
- Render pane titles if provided
- Support X-axis synchronization between panes
- Handle resize events

**Acceptance Criteria**:
- [ ] Component renders MxN grid based on layout JSON
- [ ] Each pane has its own `SciChartSurface` instance
- [ ] Surfaces are properly registered
- [ ] Grid layout is responsive
- [ ] Pane titles are displayed when provided

---

### 2. Pane Surface Registry
**Status**: ⚠️ 20% - Partial  
**Priority**: 🔴 HIGH

**Requirements**:
- Map `paneId` to actual `SciChartSurface` instances
- Store surfaces in registry (Map or similar structure)
- Support dynamic pane creation/destruction when layout changes
- Update series routing to use actual surfaces from registry
- Remove hardcoded string matching for pane lookup
- Register surfaces when panes are created
- Unregister surfaces when panes are destroyed
- Handle layout changes (preserve existing surfaces, destroy unused ones)

**Acceptance Criteria**:
- [ ] Surfaces stored in registry by `paneId`
- [ ] Series routing uses actual surface from registry
- [ ] Registry updates when layout changes
- [ ] No memory leaks (surfaces properly cleaned up)

---

## 🟡 MEDIUM-HIGH Priority

### 3. Dedicated PnL Plot
**Status**: ⚠️ 10% - Partial  
**Priority**: 🟡 MEDIUM-HIGH

**Requirements**:
- Create separate `SciChartSurface` for PnL when layout specifies it
- Identify PnL pane by pane ID from layout
- Register PnL surface in pane registry
- Handle PnL-specific Y-axis scaling (accommodate positive and negative values)
- Auto-scale based on PnL data range
- Route PnL series (`*:strategy:*:pnl`) to PnL pane only
- Ensure PnL series never goes to other panes
- Support PnL pane specification in layout JSON

**Acceptance Criteria**:
- [ ] PnL has its own dedicated plot surface
- [ ] PnL series routes only to PnL pane
- [ ] PnL Y-axis scales appropriately for positive/negative values
- [ ] Layout JSON can specify PnL pane

---

## 🟡 MEDIUM Priority

### 4. Strategy Markers Routing & Rendering
**Status**: ⚠️ 30% - Partial  
**Priority**: 🟡 MEDIUM

**Requirements**:
- Render strategy markers on all eligible panes (not just tick chart)
- Use layout manager to determine which panes should show markers
- Exclude PnL and bar plots from markers
- Support `strategy_markers.exclude_panes` and `strategy_markers.include_panes` from layout
- Use timestamp to plot markers on non-tick plots
- Use sequence number for tick plots
- Use timestamp for OHLC/bar plots X-axis
- Consolidate markers by type
- Group markers by strategy and type
- Support entry markers, exit markers, and signal markers
- Apply appropriate styling per marker type

**Acceptance Criteria**:
- [ ] Strategy markers render on all eligible panes
- [ ] Markers use timestamp for non-tick plots
- [ ] PnL and bar plots exclude markers
- [ ] Markers are consolidated by type
- [ ] Layout JSON controls which panes get markers

---

### 5. Hlines/Vlines Overlays
**Status**: ❌ 0% - Not Started  
**Priority**: 🟡 MEDIUM

**Requirements**:
- Render horizontal lines (hlines) as SciChart annotations
- Read `pane.overlays.hline[]` from layout JSON
- Each hline has: `id`, `y` (value), `label`, optional `style`
- Apply styles: `stroke`, `strokeDashArray`, `strokeThickness`
- Lines span full width of pane
- Render vertical lines (vlines) as SciChart annotations
- Read `pane.overlays.vline[]` from layout JSON
- Each vline has: `id`, `x` (timestamp or sequence), `label`, optional `style`
- Lines span full height of pane
- Add annotations to appropriate `SciChartSurface` instances
- Support dynamic addition/removal when layout changes
- Handle annotation cleanup on pane destruction
- Support label positioning and styling

**Acceptance Criteria**:
- [ ] Horizontal lines render at specified Y values
- [ ] Vertical lines render at specified X values
- [ ] Lines apply styles from layout JSON
- [ ] Lines have labels when provided
- [ ] Overlays update when layout changes

---

### 6. Mid-Run Layout Loading
**Status**: ⚠️ 40% - Partial  
**Priority**: 🟡 MEDIUM

**Requirements**:
- Preserve existing `DataSeries` when layout changes
- Don't lose data when switching layouts
- Maintain data continuity across layout changes
- Move series between panes when layout changes
- Remove series from old surface
- Add series to new surface
- Handle series that are no longer in layout (hide or remove)
- Cleanup unused panes when layout changes
- Destroy `SciChartSurface` instances for removed panes
- Update pane registry
- Handle X-axis synchronization when panes change
- Maintain zoom/pan state where possible
- Re-sync axes after layout change
- Update layout manager with new layout
- Trigger re-render of grid

**Acceptance Criteria**:
- [ ] Data is preserved when layout changes mid-run
- [ ] Series move to correct panes in new layout
- [ ] Unused panes are cleaned up
- [ ] X-axis synchronization works after layout change
- [ ] No memory leaks

---

## 🟢 LOW-MEDIUM Priority

### 7. "Waiting for Data" Messages
**Status**: ⚠️ 30% - Partial  
**Priority**: 🟢 LOW-MEDIUM

**Requirements**:
- Create UI component to display "Waiting for Data..." message
- Message should be an overlay on the pane
- Style appropriately (centered, visible, not intrusive)
- Show message when pane has no data yet
- Hide message when data arrives
- Use layout manager's `waitingForData` tracking
- Update state when series data arrives
- Handle edge cases (no series assigned to pane, data never arrives)

**Acceptance Criteria**:
- [ ] "Waiting for Data..." message displays in empty panes
- [ ] Message disappears when data arrives
- [ ] Message is styled appropriately
- [ ] Works for all pane types

---

## 🟢 LOW Priority

### 8. Layout Validation & Error Handling
**Status**: ⚠️ Partial  
**Priority**: 🟢 LOW

**Requirements**:
- Validate grid dimensions match pane count
- Validate pane IDs are unique
- Validate series reference valid pane IDs
- Validate overlay coordinates are within reasonable ranges
- Provide clear error messages for invalid layouts
- Log validation errors to console
- Show user-friendly error messages in UI

**Acceptance Criteria**:
- [ ] Invalid layouts are caught and reported
- [ ] Error messages are clear and actionable
- [ ] App doesn't crash on invalid layout

---

### 9. Layout Examples & Testing
**Status**: ❌ Not Started  
**Priority**: 🟢 LOW

**Requirements**:
- Create test layouts for various scenarios:
  - 1x1 grid (single pane)
  - 2x2 grid (4 panes)
  - 3x3 grid (9 panes)
  - Layout with PnL pane
  - Layout with overlays
  - Layout with strategy markers configuration
- Document layout JSON structure
- Provide examples for common use cases
- Document best practices

**Acceptance Criteria**:
- [ ] Test layouts cover all major scenarios
- [ ] Documentation is clear and complete
- [ ] Examples work correctly

---

## 📊 Priority Summary

| Priority | Task | Status |
|----------|------|--------|
| 🔴 CRITICAL | Dynamic Grid Rendering | ❌ 0% |
| 🔴 HIGH | Pane Surface Registry | ⚠️ 20% |
| 🟡 MEDIUM-HIGH | Dedicated PnL Plot | ⚠️ 10% |
| 🟡 MEDIUM | Strategy Markers | ⚠️ 30% |
| 🟡 MEDIUM | Hlines/Vlines Overlays | ❌ 0% |
| 🟡 MEDIUM | Mid-Run Layout Loading | ⚠️ 40% |
| 🟢 LOW-MEDIUM | "Waiting for Data" UI | ⚠️ 30% |
| 🟢 LOW | Layout Validation | ⚠️ Partial |
| 🟢 LOW | Testing & Examples | ❌ 0% |

---

## 🎯 Recommended Implementation Order

1. **Phase 1: Foundation** (Critical Path)
   - [ ] Task 1: Dynamic Grid Rendering Component
   - [ ] Task 2: Pane Surface Registry

2. **Phase 2: Core Features**
   - [ ] Task 3: Dedicated PnL Plot
   - [ ] Task 7: "Waiting for Data" Messages

3. **Phase 3: Overlays & Markers**
   - [ ] Task 5: Hlines/Vlines Overlays
   - [ ] Task 4: Strategy Markers Routing & Rendering

4. **Phase 4: Advanced Features**
   - [ ] Task 6: Mid-Run Layout Loading
   - [ ] Task 8: Enhanced Layout Validation

5. **Phase 5: Testing & Polish**
   - [ ] Task 9: Layout Examples & Testing
   - [ ] General testing and bug fixes

---

## ✅ Completion Checklist

### Core Infrastructure
- [x] TypeScript type definitions
- [x] Layout manager class
- [x] Layout parsing and validation
- [x] Basic chart integration
- [x] Default layout loading

### Dynamic Grid System
- [ ] Dynamic grid component
- [ ] CSS Grid layout
- [ ] Dynamic surface creation
- [ ] Pane surface registry
- [ ] Pane lifecycle management

### Series Routing
- [x] Series-to-pane mapping logic
- [ ] Actual surface routing
- [ ] PnL dedicated plot
- [ ] Series movement on layout change

### Overlays & Markers
- [ ] Hlines rendering
- [ ] Vlines rendering
- [ ] Strategy markers multi-pane rendering
- [ ] Timestamp-based marker plotting

### UX Features
- [ ] "Waiting for Data" UI
- [ ] Mid-run layout loading with data preservation
- [ ] Enhanced error handling

### Testing & Documentation
- [ ] Test layouts for all scenarios
- [ ] Layout JSON documentation
- [ ] Integration testing

