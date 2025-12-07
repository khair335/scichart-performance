# What is Range Restoration?

## Simple Explanation

**Range Restoration** is a feature that ensures when you switch away from the chart tab and come back, the chart automatically shows the **latest data** instead of staying where you left off.

## The Problem It Solves

### Without Range Restoration:
- You're viewing the chart at 10:00 AM
- You switch to another tab for 5 minutes
- When you come back, the chart is still showing 10:00 AM
- You have to manually scroll/zoom to see the latest data at 10:05 AM

### With Range Restoration:
- You're viewing the chart at 10:00 AM
- You switch to another tab for 5 minutes
- When you come back, the chart **automatically shows 10:05 AM** (the latest data)
- No manual scrolling needed!

## How It Works

### Step 1: Tab Becomes Hidden
When you switch away from the tab:
- The system **saves** the current X-axis visible range (what time range you were viewing)
- Data continues to be collected in the background (even though you can't see it)

### Step 2: Tab Becomes Visible
When you switch back to the tab:
1. **Calculate Latest Data**: The system examines all data series and finds the maximum timestamp (the "global data clock")
2. **Process Backlog**: Any data that arrived while the tab was hidden is processed first
3. **Set X-Axis Range**: The X-axis range is set to show the latest data (e.g., if latest data is 10:05 AM, show 9:55 AM to 10:05 AM)
4. **Prevent Interference**: Auto-scroll and Y-axis updates are temporarily disabled to prevent visual glitches

## Why It's Complex

Range restoration requires careful coordination:

1. **Data Processing**: Must process any backlog of data before setting the range
2. **Timing**: Must wait for data to be fully processed to get accurate timestamps
3. **Synchronization**: Must prevent auto-scroll from interfering during restoration
4. **Visual Stability**: Must prevent chart "shaking" or glitches during the transition

## Code Implementation

The range restoration logic is controlled by a flag `isRestoringRangeRef`:

```typescript
// When tab becomes visible:
isRestoringRangeRef.current = true;  // Start restoration

// Calculate latest data timestamp from registry
const globalDataClock = Math.max(...registry.map(r => r.lastMs || 0));

// Set X-axis range to show latest data
xAxis.visibleRange = new NumberRange(
  globalDataClock - windowSize,  // Start: 5 minutes before latest
  globalDataClock + padding      // End: slightly after latest
);

// After restoration completes:
setTimeout(() => {
  isRestoringRangeRef.current = false;  // Re-enable auto-scroll
}, 1500);
```

## Trade-offs

### Benefits:
- ✅ **Better UX**: Users always see latest data when returning
- ✅ **No Manual Scrolling**: Automatic positioning saves time
- ✅ **Meets Requirement**: Fulfills the client requirement

### Costs:
- ⚠️ **Complexity**: Adds synchronization logic and flags
- ⚠️ **Potential Glitches**: If not perfectly synchronized, can cause visual issues
- ⚠️ **Processing Delay**: Must wait for data processing before setting range

## Comparison with new-index.html

**new-index.html** (simple version):
- No range restoration logic
- Uses `requestAnimationFrame` which continues even when tab is hidden (throttled by browser)
- Appends data directly per sample (no batching)
- Chart continues from where you left off when you return
- Simpler code, but doesn't automatically jump to latest data

**Our React Implementation**:
- Has range restoration (requirement: show latest data when you return)
- Uses `requestAnimationFrame` even when tab is hidden (matches new-index.html behavior)
- Batches data for performance (necessary for millions of points)
- Automatically shows latest data when you return
- More complex code due to batching + range restoration, but meets the requirement

## Can We Simplify It?

Yes, but it would mean:
- ❌ Losing the "show latest data when you return" feature
- ❌ Users would need to manually scroll to see latest data
- ❌ Wouldn't meet the original requirement

## Summary

**Range Restoration** = The feature that automatically positions the chart to show the latest data when you switch back to the tab, instead of staying where you left off.

It's a **requirement** (not optional), which is why the code is more complex than the simple `new-index.html` version.

