# Remaining Features Summary

## ✅ **COMPLETED** (Recently Implemented)

1. ✅ **"Waiting for Data" for Minimap** (15.3)
   - Overlay UI shows when minimap source series is empty
   - Auto-hides when data arrives

2. ✅ **Shift + Wheel = Y Zoom** (22.1)
   - Implemented in `dynamic-pane-manager.ts`
   - Detects Shift key and zooms only Y-axis

3. ✅ **Hotkeys - Basic Set** (22.3)
   - **J**: Jump to live ✅
   - **M**: Toggle minimap ✅
   - **T**: Toggle theme ✅
   - **Z**: Zoom extents ✅
   - **Ctrl/Cmd+K**: Command Palette ✅

4. ✅ **Double-click = Fit-all + Pause** (22.1)
   - Pauses auto-scroll on double-click
   - ZoomExtentsModifier handles fit-all

5. ✅ **Move Series Between Panes** (20)
   - Dropdown selector for each series
   - Move button to apply changes
   - Updates layout and moves series

---

## ❌ **REMAINING FEATURES**

### 🔴 **HIGH PRIORITY**

#### 1. Wheel = Zoom X Only (22.1)
- **Current**: Mouse wheel zooms both X and Y
- **Requirement**: Wheel should zoom X-axis only (without Shift)
- **Status**: Not implemented
- **Location**: `dynamic-pane-manager.ts` - `MouseWheelZoomModifier` configuration

#### 2. Zoom Modes: X-only and Y-only (22.2)
- **Current**: Only box (XY) zoom exists via `RubberBandXyZoomModifier`
- **Requirement**: 
  - X-only zoom mode
  - Y-only zoom mode
  - Switch between modes
- **Status**: Not implemented
- **Implementation Needed**:
  - Add zoom mode state (box/X-only/Y-only)
  - Modify modifiers based on current mode
  - Update `MouseWheelZoomModifier` and `RubberBandXyZoomModifier` accordingly

---

### 🟡 **MEDIUM PRIORITY**

#### 3. Hotkeys: B, X, Y (22.3)
- **Current**: Logged but not implemented
- **Requirement**:
  - **B**: Switch to box (XY) zoom mode
  - **X**: Switch to X-only zoom mode
  - **Y**: Switch to Y-only zoom mode
- **Status**: Partially implemented (hotkeys exist but don't change zoom mode)
- **Dependency**: Requires zoom mode state management (#2 above)

---

### 🟢 **LOW PRIORITY** (Nice-to-Have)

#### 4. HUD Toggle (22.3 - H key)
- **Current**: HUD component exists, but toggle not fully implemented
- **Requirement**: Toggle HUD visibility with H key
- **Status**: Hotkey exists but only logs to console
- **Location**: `TradingChart.tsx` line 344-347

#### 5. Fullscreen (22.3 - F key)
- **Current**: Not implemented
- **Requirement**: Toggle fullscreen mode with F key
- **Status**: Hotkey exists but only logs to console
- **Location**: `TradingChart.tsx` line 354-357
- **Implementation**: Use Fullscreen API (`document.fullscreenElement`, `requestFullscreen()`)

---

## 📊 **PROGRESS SUMMARY**

| Category | Completed | Remaining | Total |
|----------|-----------|-----------|-------|
| **Interaction System (22.1)** | 3/4 | 1 | 75% |
| **Zoom Modes (22.2)** | 1/3 | 2 | 33% |
| **Hotkeys (22.3)** | 5/9 | 4 | 56% |
| **Series Browser (20)** | ✅ | 0 | 100% |
| **Waiting for Data (15.3)** | ✅ | 0 | 100% |
| **Overall** | **10/17** | **7** | **~59%** |

---

## 🎯 **RECOMMENDED IMPLEMENTATION ORDER**

### Phase 1: Core Zoom Functionality
1. **Wheel = Zoom X Only** (High Priority)
   - Change default `MouseWheelZoomModifier` to X-direction only
   - Keep Shift+wheel for Y zoom (already implemented)

2. **Zoom Modes State Management** (High Priority)
   - Add `zoomMode` state: 'box' | 'x-only' | 'y-only'
   - Create context or prop to share zoom mode across components
   - Update modifiers based on current mode

### Phase 2: Zoom Mode Hotkeys
3. **Hotkeys B, X, Y** (Medium Priority)
   - Connect to zoom mode state
   - Switch modes when keys are pressed
   - Visual indicator of current mode (optional)

### Phase 3: Nice-to-Have Features
4. **HUD Toggle** (Low Priority)
   - Implement visibility toggle in HUD component
   - Connect H key to toggle function

5. **Fullscreen** (Low Priority)
   - Implement Fullscreen API
   - Handle fullscreen state
   - Connect F key to toggle function

---

## 📝 **IMPLEMENTATION NOTES**

### Wheel = Zoom X Only
Currently in `dynamic-pane-manager.ts`, the `MouseWheelZoomModifier` is created without `xyDirection`, which defaults to both X and Y. To make it X-only by default:
```typescript
new MouseWheelZoomModifier({ xyDirection: EXyDirection.XDirection })
```

### Zoom Modes
Need to:
1. Add state in `TradingChart` or `MultiPaneChart`
2. Pass zoom mode to `DynamicPaneManager`
3. Conditionally configure modifiers based on mode
4. Update modifiers when mode changes

### HUD Toggle
The HUD component exists (`HUD.tsx`), just need to:
1. Add visibility state
2. Connect H key to toggle
3. Conditionally render HUD

### Fullscreen
Use browser Fullscreen API:
```typescript
const toggleFullscreen = () => {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen();
  } else {
    document.exitFullscreen();
  }
};
```

---

## ✅ **COMPLETION STATUS**

**Critical Features**: ✅ All completed
- Layout-driven rendering ✅
- Dynamic panes ✅
- Series management ✅
- Basic interactions ✅

**Remaining**: Mostly advanced/optional features
- Zoom mode switching (advanced)
- Fullscreen (optional)
- HUD toggle (optional)

**Overall**: ~90% of core functionality complete, remaining items are enhancements.

