# SubCharts X-Axis Linking and SciChartOverview Integration

## Question 1: Does SciChart SubCharts API let you link all x axes?

### Short Answer

**Yes, but there are two different approaches:**

1. **`parentXAxisId` method** (Official example approach)
2. **`SciChartVerticalGroup` method** (Current implementation)

### Method 1: Using `parentXAxisId` (Official Example)

The official SciChart example (`drawerexample.ts`) uses `parentXAxisId` in the sub-surface options:

```typescript
const subChartOptions: I2DSubSurfaceOptions = {
    id: `subChart-${subChartIndex}`,
    theme: sciChartTheme,
    position,
    parentXAxisId: mainXAxis.id,  // ← Links to parent X-axis
    parentYAxisId: mainYAxis.id,
    coordinateMode: subChartPositioningCoordinateMode,
    // ...
};

const subChartSurface = SciChartSubSurface.createSubSurface(mainSurface, subChartOptions);
```

**How it works:**
- Creates a **parent axis** on the main surface
- Each sub-surface references the parent via `parentXAxisId`
- All sub-charts automatically share the same X-axis range
- Changes to parent axis propagate to all sub-charts

**Pros:**
- ✅ Native SubCharts API feature
- ✅ Automatic synchronization
- ✅ No manual event handling needed
- ✅ Works seamlessly with SubCharts

**Cons:**
- ⚠️ Requires a visible parent axis (or hidden parent axis)
- ⚠️ All sub-charts must share the same parent

### Method 2: Using `SciChartVerticalGroup` (Current Implementation)

Your current code uses `SciChartVerticalGroup` to link independent surfaces:

```typescript
// From dynamic-pane-manager.ts, line ~429
if (this.verticalGroup) {
    this.verticalGroup.addSurfaceToGroup(surface);
}
```

**How it works:**
- Creates a `SciChartVerticalGroup` instance
- Adds each surface to the group via `addSurfaceToGroup()`
- All surfaces in the group have synchronized X-axes
- Works with independent surfaces (not just SubCharts)

**Pros:**
- ✅ Works with any surfaces (SubCharts or independent)
- ✅ More flexible - can link surfaces created separately
- ✅ Each surface keeps its own X-axis (just synchronized)

**Cons:**
- ⚠️ Requires manual group management
- ⚠️ May have slight performance overhead vs. `parentXAxisId`

### Current Implementation Status

**✅ X-axes ARE linked** in your code:

```typescript
// From MultiPaneChart.tsx, line ~2202
// Add to vertical group to link X-axes across all panes
// Requirement 17: All panes must have their own X-axis, all linked and synchronized
if (refs.verticalGroup) {
    try {
        refs.verticalGroup.addSurfaceToGroup(paneSurface.surface);
    } catch (e) {
        // Ignore if already in group
    }
}
```

**All dynamic panes are added to the vertical group**, so their X-axes are synchronized.

### Recommendation

**For SubCharts specifically**, the `parentXAxisId` method is more idiomatic and may perform slightly better. However, your current `SciChartVerticalGroup` approach **works correctly** and is more flexible.

**If you want to switch to `parentXAxisId`**, you would need to:
1. Create a parent X-axis on the parent surface
2. Pass `parentXAxisId` when creating sub-surfaces
3. Remove the `SciChartVerticalGroup` code

But **this is optional** - your current implementation is correct and functional.

---

## Question 2: Does it let you link it with SciChartOverview?

### Short Answer

**SciChartOverview has built-in synchronization**, but it **cannot be added to `SciChartVerticalGroup`** directly. However, you can manually sync it (as you're currently doing).

### How SciChartOverview Works

**Built-in Features:**
- ✅ Automatically syncs with the source surface
- ✅ Shows all series from the source surface
- ✅ Interactive - dragging overview window updates main chart
- ✅ Overview window highlights the main chart's visible range

**Current Implementation:**

```typescript
// From MultiPaneChart.tsx, line ~1279
const overview = await SciChartOverview.create(sourceSurface, overviewContainerId, {
    theme: chartTheme,
});
```

The overview is created from a **source surface** and automatically:
- Shows all series on that surface
- Syncs its window to the source surface's visible range
- Allows navigation by dragging the window

### Manual Synchronization (Current Code)

Your code manually syncs the overview in live mode:

```typescript
// From MultiPaneChart.tsx, line ~4765
if (latestTime > 0 && refs.overview && isLiveRef.current && feedStageRef.current === 'live') {
    const overviewSurface = (refs.overview as any).sciChartSurface;
    const overviewXAxis = overviewSurface.xAxes.get(0);
    const mainXAxis = refs.tickSurface?.xAxes.get(0) || 
        (plotLayout ? Array.from(refs.paneSurfaces.values())[0]?.xAxis : null);
    
    if (mainXAxis && mainXAxis.visibleRange) {
        const mainRange = mainXAxis.visibleRange;
        overviewXAxis.visibleRange = new NumberRange(mainRange.min, mainRange.max);
    }
}
```

**Why manual sync?**
- SciChartOverview's built-in sync works for the **source surface**
- But if you want it to sync with a **different surface** (e.g., first pane in a multi-pane layout), you need manual sync
- In live mode, the main chart auto-scrolls, so you need to update the overview window

### Can SciChartOverview Be Added to SciChartVerticalGroup?

**❌ No, not directly.**

`SciChartOverview` is a **special component** that:
- Has its own internal surface (`sciChartSurface`)
- Uses a different synchronization mechanism
- Is not designed to be added to `SciChartVerticalGroup`

**However**, you can access its internal surface and manually sync:

```typescript
const overviewSurface = (overview as any).sciChartSurface;
// You could theoretically add this to verticalGroup, but it's not recommended
// because SciChartOverview has its own sync mechanism
```

### Best Practice

**For SubCharts with SciChartOverview:**

1. **Use `parentXAxisId`** for linking SubCharts X-axes (if switching from VerticalGroup)
2. **Create overview from the parent surface** (or first pane surface)
3. **Let SciChartOverview handle its own sync** (it will sync with the source surface automatically)
4. **Only manually sync if** you need the overview to track a different surface than its source

### Current Implementation Assessment

**✅ Your implementation is correct:**

1. **X-axes are linked** via `SciChartVerticalGroup` ✅
2. **Overview is created** from the correct source surface ✅
3. **Manual sync in live mode** ensures overview tracks the main chart ✅

**Potential Improvement:**

If you want the overview to automatically sync with all panes (not just the source surface), you could:
- Create the overview from the **parent surface** (if using `parentXAxisId`)
- Or keep manual sync but sync with the **first pane** in the vertical group

---

## Summary

| Feature | Status | Method |
|---------|--------|--------|
| **Link SubCharts X-axes** | ✅ Yes | `SciChartVerticalGroup` (current) or `parentXAxisId` (alternative) |
| **Link Overview with SubCharts** | ⚠️ Partial | Built-in sync + manual sync for live mode |
| **Add Overview to VerticalGroup** | ❌ No | Overview has its own sync mechanism |

### Recommendations

1. **Keep current X-axis linking** - `SciChartVerticalGroup` works fine
2. **Keep current overview sync** - Manual sync is necessary for live mode
3. **Optional**: Consider `parentXAxisId` if you want more native SubCharts integration

---

**Document Version:** 1.0  
**Date:** 2024  
**Author:** Technical Documentation Team

