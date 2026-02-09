/**
 * Interpolate Y-value from an XyDataSeries at an exact X position.
 * 
 * Instead of snapping to the nearest data point (which causes visible offset),
 * this performs linear interpolation between the two surrounding data points
 * so markers sit exactly on the plotted line.
 */
import { XyDataSeries, ESearchMode } from 'scichart';

/**
 * Look up the Y-value at a given X by linearly interpolating between
 * the two surrounding points in the data series.
 * 
 * @param dataSeries - The XyDataSeries to look up from
 * @param x - The X value (in the same units as the data series, e.g. Unix seconds)
 * @returns The interpolated Y value, or null if lookup fails
 */
export function interpolateYValue(dataSeries: XyDataSeries, x: number): number | null {
  const count = dataSeries.count();
  if (count === 0) return null;

  try {
    const xValues = dataSeries.getNativeXValues();
    const yValues = dataSeries.getNativeYValues();
    if (!xValues || !yValues || xValues.size() === 0) return null;

    // Find nearest index
    const nearestIdx = dataSeries.findIndex(x, ESearchMode.Nearest);
    if (nearestIdx < 0 || nearestIdx >= count) return null;

    const nearestX = xValues.get(nearestIdx);

    // Exact match — no interpolation needed
    if (nearestX === x) {
      return yValues.get(nearestIdx);
    }

    let idx0: number;
    let idx1: number;

    if (nearestX < x) {
      // Nearest is to the left; interpolate between nearest and next
      idx0 = nearestIdx;
      idx1 = nearestIdx + 1;
    } else {
      // Nearest is to the right; interpolate between previous and nearest
      idx0 = nearestIdx - 1;
      idx1 = nearestIdx;
    }

    // Boundary checks — if at the edge, just return nearest Y
    if (idx0 < 0 || idx1 >= count) {
      return yValues.get(nearestIdx);
    }

    const x0 = xValues.get(idx0);
    const x1 = xValues.get(idx1);
    const y0 = yValues.get(idx0);
    const y1 = yValues.get(idx1);

    // Avoid division by zero (duplicate timestamps)
    const dx = x1 - x0;
    if (dx === 0) return y0;

    // Linear interpolation: y = y0 + (y1 - y0) * ((x - x0) / (x1 - x0))
    const t = (x - x0) / dx;
    return y0 + (y1 - y0) * t;
  } catch (e) {
    return null;
  }
}
