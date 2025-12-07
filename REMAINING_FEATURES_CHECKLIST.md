# Remaining Features Checklist

## Status Check Results

### ✅ **FULLY IMPLEMENTED**

#### 13. "Waiting for Data" UI
- ✅ Component exists in `DynamicPlotGrid.tsx` (lines 89-100)
- ✅ Shows overlay when pane has no data
- ✅ Auto-hides when data arrives
- ⚠️ **Missing**: Not shown for minimap when source is empty

#### 20. Series Browser
- ✅ Component exists (`SeriesBrowser.tsx`)
- ✅ Shows all discovered series
- ✅ Groups by namespace/type
- ✅ Shows metadata (count, timestamps)
- ✅ Toggle visibility
- ✅ Select All / Clear All buttons
- ❌ **Missing**: "Move series between panes" functionality

#### 22.3 Hotkeys - Ctrl/Cmd+K
- ✅ Command Palette with Ctrl/Cmd+K shortcut
- ✅ Implemented in `TradingChart.tsx` (lines 302-312)

#### 22.1 Mouse/Wheel - Basic Interactions
- ✅ Drag = pan: `ZoomPanModifier({ enableZoom: false })`
- ✅ Wheel = zoom: `MouseWheelZoomModifier()` (currently zooms both X and Y)
- ✅ Box zoom: `RubberBandXyZoomModifier()`
- ✅ Double-click fit: `ZoomExtentsModifier()`

---

### ❌ **NOT IMPLEMENTED / INCOMPLETE**

#### 15.3 States - "Waiting for Data" for Minimap
- ❌ **Status**: Not implemented
- **Requirement**: Show "Waiting for Data" when minimap source series is empty
- **Current**: Minimap is created but no waiting state UI

#### 22.1 Mouse/Wheel - Advanced Interactions
- ❌ **Shift + wheel = zoom Y**: Not implemented
  - Current: Mouse wheel zooms both X and Y
  - Need: Detect Shift key and zoom only Y-axis
  
- ❌ **Double-click = fit-all + pause**: Partially implemented
  - Current: `ZoomExtentsModifier` fits all data
  - Missing: Does not pause auto-scroll on double-click

#### 22.2 Zoom Modes
- ❌ **X-only zoom mode**: Not implemented
- ❌ **Y-only zoom mode**: Not implemented
- **Current**: Only box (XY) zoom exists via `RubberBandXyZoomModifier`

#### 22.3 Hotkeys
- ❌ **B, X, Y, Z**: Not implemented
  - B = Box zoom mode?
  - X = X-only zoom?
  - Y = Y-only zoom?
  - Z = Zoom extents?
  
- ❌ **J (Jump to live)**: Not implemented as hotkey
  - Current: Only available via Command Palette or Toolbar button
  - Need: Direct 'J' key shortcut
  
- ❌ **M, H, T, F**: Not implemented
  - M = Toggle minimap?
  - H = Toggle HUD?
  - T = Toggle theme?
  - F = Fullscreen?

#### 20. Series Browser - Move Series Between Panes
- ❌ **Status**: Not implemented
- **Current**: Only visibility toggle exists
- **Requirement**: Allow users to reassign series to different panes
- **Implementation Needed**:
  - Dropdown/select for each series to choose target pane
  - Update layout JSON or trigger layout reload
  - Move series DataSeries to new pane surface

---

## Implementation Priority

### 🔴 **HIGH PRIORITY** (Core Functionality)

1. **"Waiting for Data" for Minimap** (15.3)
   - Show overlay when minimap source series is empty
   - Similar to pane waiting overlay

2. **Move Series Between Panes** (20)
   - Core requirement for Series Browser
   - Allows dynamic series reassignment

### 🟡 **MEDIUM PRIORITY** (User Experience)

3. **Shift + Wheel = Y Zoom** (22.1)
   - Common interaction pattern
   - Improves usability

4. **Double-click = Fit-all + Pause** (22.1)
   - Expected behavior
   - Pause auto-scroll when user zooms

5. **Hotkey: J (Jump to Live)** (22.3)
   - Quick access to latest data
   - Common in trading applications

### 🟢 **LOW PRIORITY** (Nice-to-Have)

6. **Zoom Modes: X-only, Y-only** (22.2)
   - Advanced feature
   - Can use modifiers for now

7. **Hotkeys: B, X, Y, Z, M, H, T, F** (22.3)
   - Convenience shortcuts
   - Most actions available via UI

---

## Summary

| Feature | Status | Priority |
|---------|--------|----------|
| "Waiting for Data" (Panes) | ✅ Done | - |
| "Waiting for Data" (Minimap) | ❌ Missing | 🔴 High |
| Series Browser - Move Between Panes | ❌ Missing | 🔴 High |
| Shift + Wheel = Y Zoom | ❌ Missing | 🟡 Medium |
| Double-click = Fit + Pause | ⚠️ Partial | 🟡 Medium |
| Hotkey: J (Jump to Live) | ❌ Missing | 🟡 Medium |
| Zoom Modes (X-only, Y-only) | ❌ Missing | 🟢 Low |
| Hotkeys (B, X, Y, Z, M, H, T, F) | ❌ Missing | 🟢 Low |

**Overall**: 2 critical features missing, 3 medium-priority features missing

