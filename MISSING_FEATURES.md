# Missing Features Analysis

Based on comprehensive review of the codebase against `Task.md` requirements, here are the features that are **partially implemented** or **missing**:

---

## 🔴 Critical Missing Features

### 1. **Layout Validation (7.2)** - Partially Missing
**Status**: Basic validation exists, but missing:
- ❌ **Validate unique pane IDs** - Currently uses `Map.set()` which silently overwrites duplicates
- ❌ **Validate rows/cols match grid definition** - No check that pane positions fit within grid
- ❌ **Validate overlay values** - No validation for hline/vline Y values
- ❌ **Display errors clearly in UI** - Currently only `console.error()`, no user-facing error display

**Location**: `src/types/plot-layout.ts` - `parsePlotLayout()` function

---

### 2. **Toolbar Showing Current Layout (7.2, 19)** - Missing
**Status**: Not implemented
- ❌ **Display loaded layout filename** - Toolbar doesn't show which layout JSON is currently active
- ❌ **Layout metadata display** - No way to see layout name/version in UI

**Location**: `src/components/chart/Toolbar.tsx`

**Requirement**: "All loaded plot layout json file should be somewhere in the UI toolbar."

---

### 3. **Timezone-Based Label Formatting (17)** - Missing
**Status**: Config has timezone, but not used
- ❌ **DateTime axis label formatting** - `DateTimeNumericAxis` doesn't use `config.chart.timezone`
- ❌ **Timezone-aware labels** - Labels always show in UTC/local, not configured timezone

**Location**: `src/components/chart/MultiPaneChart.tsx` - DateTimeNumericAxis creation
**Config**: `uiConfig.chart.timezone` exists but not applied

---

### 4. **Strategy Marker Consolidation (11.2)** - Missing
**Status**: Markers are duplicated, not consolidated
- ❌ **Group by instrument** - Not grouping markers
- ❌ **Group by strategy** - Not grouping markers
- ❌ **Group by marker type** - Not grouping markers
- ❌ **One annotation per group** - Currently creates separate DataSeries for each duplicate

**Location**: `src/components/chart/MultiPaneChart.tsx` - Strategy marker duplication logic (lines ~1465-1545)

**Current Behavior**: Creates separate `XyDataSeries` for each pane duplicate
**Required Behavior**: Group markers and create single annotation per group

---

### 5. **Minimap Window Logic (15.2)** - Missing
**Status**: Minimap exists but missing advanced features
- ❌ **Live mode: right edge = dataClockMs** - Minimap doesn't auto-update window to latest data
- ❌ **Draggable window edges** - No user interaction with minimap window
- ❌ **Paused mode: window freely movable** - Minimap window not interactive

**Location**: `src/components/chart/MultiPaneChart.tsx` - Overview creation (lines ~990-1120)

**Current Behavior**: Uses `SciChartOverview` with default behavior
**Required Behavior**: Custom window logic with dataClockMs tracking and draggable edges

---

## 🟡 Nice-to-Have Missing Features

### 6. **HUD/Toolbar Auto-Hide (18, 19)** - Missing
**Status**: Config exists, but not implemented
- ❌ **HUD auto-hide** - `uiConfig.ui.hud.autoHideMs` not used
- ❌ **Toolbar auto-hide** - `uiConfig.ui.toolbar.autoHide` not used
- ❌ **Opacity idle state** - `uiConfig.ui.toolbar.opacityIdle` not used

**Location**: `src/components/chart/HUD.tsx`, `src/components/chart/Toolbar.tsx`

---

### 7. **Zoom/Pan State Preservation (14)** - Missing
**Status**: Not implemented
- ❌ **Preserve zoom state** - When switching layouts mid-run, zoom level is lost
- ❌ **Preserve pan state** - X-axis visible range is reset on layout change

**Location**: `src/components/chart/MultiPaneChart.tsx` - Layout change handler

**Requirement**: "Retain zoom/pan state if possible"

---

## ✅ Fully Implemented Features

The following are **fully implemented** and working:
- ✅ Layout-driven rendering (0.1)
- ✅ Layout JSON as single source of truth (0.2)
- ✅ PnL dedicated plot (0.3)
- ✅ Strategy marker placement rules (0.4, 11.1)
- ✅ Dynamic grid rendering (8)
- ✅ Pane surface registry (9)
- ✅ Overlays (hlines/vlines) (12)
- ✅ "Waiting for Data" UI (13)
- ✅ Mid-run layout loading (14) - *except zoom/pan preservation*
- ✅ Minimap rendering (15.1)
- ✅ Global data clock (16)
- ✅ Axes linking (17) - *except timezone formatting*
- ✅ HUD display (18) - *except auto-hide*
- ✅ Toolbar (19) - *except auto-hide and layout display*
- ✅ Series Browser (20)
- ✅ Command Palette (21)
- ✅ Interaction System (22) - **All implemented!**
- ✅ Theme (23)
- ✅ Performance optimizations (24)

---

## 📋 Priority Recommendations

### High Priority (Should Implement):
1. **Layout Validation** - Prevents user errors, improves UX
2. **Toolbar Layout Display** - User needs to know which layout is active
3. **Timezone Label Formatting** - Important for trading applications

### Medium Priority (Nice to Have):
4. **Strategy Marker Consolidation** - Performance optimization
5. **Minimap Window Logic** - Enhanced UX feature

### Low Priority (Optional):
6. **HUD/Toolbar Auto-Hide** - UI polish
7. **Zoom/Pan State Preservation** - Convenience feature

---

## 🛠️ Implementation Notes

### Layout Validation
Add to `parsePlotLayout()`:
```typescript
// Check for duplicate pane IDs
const paneIds = new Set<string>();
for (const pane of layout.panes) {
  if (paneIds.has(pane.id)) {
    throw new Error(`Duplicate pane ID: ${pane.id}`);
  }
  paneIds.add(pane.id);
  
  // Validate grid bounds
  if (pane.row >= layout.grid[0] || pane.col >= layout.grid[1]) {
    throw new Error(`Pane ${pane.id} is outside grid bounds`);
  }
}
```

### Toolbar Layout Display
Add to `Toolbar.tsx`:
```typescript
{currentLayoutName && (
  <div className="text-xs text-muted-foreground">
    Layout: {currentLayoutName}
  </div>
)}
```

### Timezone Label Formatting
Use `DateTimeNumericAxis` label formatter with timezone:
```typescript
const xAxis = new DateTimeNumericAxis(wasm, {
  // ... other options
  labelFormat: (value: number) => {
    const date = new Date(value);
    return date.toLocaleString('en-US', { 
      timeZone: config.chart.timezone,
      // ... format options
    });
  }
});
```

---

**Summary**: Most critical features are implemented. The missing items are primarily validation, UI polish, and advanced minimap features. The core functionality is solid and production-ready.

