/**
 * Strategy Marker Renderer Utilities
 * Parses strategy marker data from WebSocket samples
 */

export interface MarkerData {
  x: number; // Unix timestamp in seconds (matches DateTimeNumericAxis)
  y: number; // Price level
  type: 'entry' | 'exit' | 'signal';
  direction?: 'long' | 'short';
  label?: string;
}

/**
 * Parse marker data from a sample
 * Server binary format sends: { strategy, side, tag, price, qty }
 * Server may also send: { type, direction, label } for JSON format
 */
export function parseMarkerFromSample(sample: {
  t_ms: number;
  v: number;
  // Binary format fields
  side?: string;
  tag?: string;
  // JSON format fields (alternative)
  type?: string;
  direction?: string;
  label?: string;
}, seriesId?: string): MarkerData {
  // Determine marker type from tag field (binary) or type field (JSON) or series_id
  let markerType: 'entry' | 'exit' | 'signal' = 'signal';
  
  // Check tag field first (binary format: "entry", "exit", etc.)
  const tag = sample.tag?.toLowerCase() || sample.type?.toLowerCase() || '';
  if (tag.includes('entry') || tag === 'buy' || tag === 'open') {
    markerType = 'entry';
  } else if (tag.includes('exit') || tag === 'sell' || tag === 'close') {
    markerType = 'exit';
  } else if (seriesId?.includes(':signals')) {
    markerType = 'signal';
  } else if (seriesId?.includes(':markers')) {
    // Markers without explicit type default to entry
    markerType = 'entry';
  }

  // Determine direction from side field (binary: "long"/"short") or direction field (JSON)
  let direction: 'long' | 'short' | undefined;
  const side = sample.side || sample.direction;
  if (side === 'long' || side === 'L' || tag.includes('long')) {
    direction = 'long';
  } else if (side === 'short' || side === 'S' || tag.includes('short')) {
    direction = 'short';
  }

  return {
    x: sample.t_ms / 1000, // Convert to Unix seconds to match DateTimeNumericAxis
    y: sample.v,
    type: markerType,
    direction,
    label: sample.tag || sample.label,
  };
}
