# FastMountainRenderableSeries Implementation

## ✅ Completed

### 1. Type Definitions
- ✅ Added `FastMountainRenderableSeries` to `SeriesAssignment.type` union type
- ✅ Updated `DataSeriesEntry.renderableSeries` to include `FastMountainRenderableSeries`
- ✅ Added `renderableSeriesType` field to `DataSeriesEntry` to store the type from layout

### 2. Imports
- ✅ Added `FastMountainRenderableSeries` to SciChart imports in `MultiPaneChart.tsx`

### 3. Series Creation Logic
- ✅ Created `getRenderableSeriesType()` helper function that:
  - Checks layout JSON for explicit `type` field
  - Falls back to inferring from series type (OHLC → Candlestick, others → Line)
- ✅ Updated `ensureSeriesExists()` to support mountain series
- ✅ Updated registry preallocation logic to support mountain series
- ✅ Mountain series use `XyDataSeries` (same as line series)
- ✅ Mountain series have fill color with transparency (`stroke + '44'`)

### 4. Test Layout
- ✅ Created `layout-with-mountain.json` test file showing mountain series usage

---

## How It Works

### Layout JSON Example:
```json
{
  "series": [
    {
      "series_id": "MESU5:ticks",
      "pane": "tick-pane",
      "type": "FastLineRenderableSeries"
    },
    {
      "series_id": "MESU5:sma_10",
      "pane": "tick-pane",
      "type": "FastMountainRenderableSeries"
    },
    {
      "series_id": "MESU5:ohlc_time:10000",
      "pane": "ohlc-pane",
      "type": "FastCandlestickRenderableSeries"
    }
  ]
}
```

### Series Type Resolution:
1. **From Layout**: If `series_id` is in layout's `series` array, use the `type` field
2. **Fallback**: 
   - OHLC bars → `FastCandlestickRenderableSeries`
   - All others → `FastLineRenderableSeries`

### Mountain Series Properties:
- Uses `XyDataSeries` (same data structure as line series)
- Has both `stroke` (line color) and `fill` (area fill with transparency)
- Fill color is automatically set to `stroke + '44'` (adds 44 hex for transparency)
- Supports same resampling modes as line series

---

## Testing

### Test File: `layout-with-mountain.json`
- Load this layout to see mountain series in action
- `MESU5:sma_10` will be rendered as a mountain/area chart
- Other series remain as line or candlestick

### Console Logs:
When a mountain series is created, you'll see:
```
[MultiPaneChart] Created DataSeries on-demand for MESU5:sma_10 (tick-indicator) on tick-pane pane with capacity 1000000, type: FastMountainRenderableSeries, resamplingMode: Auto
```

---

## Supported Series Types

| Layout Type | DataSeries | RenderableSeries | Use Case |
|------------|------------|------------------|----------|
| `FastLineRenderableSeries` | `XyDataSeries` | `FastLineRenderableSeries` | Tick data, indicators, PnL |
| `FastMountainRenderableSeries` | `XyDataSeries` | `FastMountainRenderableSeries` | Indicators with area fill |
| `FastCandlestickRenderableSeries` | `OhlcDataSeries` | `FastCandlestickRenderableSeries` | OHLC bars |

---

## Notes

- Mountain series are created from `XyDataSeries`, so they work with any XY data
- The fill color is automatically derived from stroke color with transparency
- Mountain series support the same resampling modes as line series
- If layout doesn't specify a type, it defaults to `FastLineRenderableSeries` (except OHLC which uses candlestick)




