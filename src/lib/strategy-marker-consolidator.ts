/**
 * Strategy Marker Consolidation
 * Groups strategy markers by instrument/strategy/type into single annotations
 * Requirement 11.2: Consolidate markers by grouping them
 */

import { parseSeriesType } from './series-namespace';

export interface MarkerGroup {
  instrument: string;
  strategy: string;
  markerType: 'markers' | 'signals';
  groupKey: string; // Unique key: "instrument:strategy:type"
  seriesIds: string[]; // All series IDs in this group
}

/**
 * Extract instrument, strategy, and marker type from series ID
 * Pattern: <instrument>:strategy:<strategy>:<markers|signals>
 * Example: ES.c.0:strategy:alpha:markers
 */
export function parseStrategyMarkerId(seriesId: string): {
  instrument: string;
  strategy: string;
  markerType: 'markers' | 'signals' | null;
} | null {
  if (!seriesId.includes(':strategy:')) {
    return null;
  }
  
  const parts = seriesId.split(':');
  const strategyIndex = parts.findIndex(p => p === 'strategy');
  
  if (strategyIndex === -1 || strategyIndex >= parts.length - 2) {
    return null;
  }
  
  // Instrument is everything before :strategy:
  const instrument = parts.slice(0, strategyIndex).join(':');
  
  // Strategy is the part after :strategy:
  const strategy = parts[strategyIndex + 1] || '';
  
  // Marker type is the last part (markers or signals)
  const lastPart = parts[parts.length - 1];
  const markerType = lastPart === 'markers' || lastPart === 'signals' ? lastPart : null;
  
  return {
    instrument,
    strategy,
    markerType,
  };
}

/**
 * Group strategy marker series by instrument/strategy/type
 */
export function groupStrategyMarkers(seriesIds: string[]): Map<string, MarkerGroup> {
  const groups = new Map<string, MarkerGroup>();
  
  for (const seriesId of seriesIds) {
    const seriesInfo = parseSeriesType(seriesId);
    
    // Only process strategy markers and signals
    if (seriesInfo.type !== 'strategy-marker' && seriesInfo.type !== 'strategy-signal') {
      continue;
    }
    
    const parsed = parseStrategyMarkerId(seriesId);
    if (!parsed || !parsed.markerType) {
      continue;
    }
    
    // Create group key: "instrument:strategy:type"
    const groupKey = `${parsed.instrument}:${parsed.strategy}:${parsed.markerType}`;
    
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        instrument: parsed.instrument,
        strategy: parsed.strategy,
        markerType: parsed.markerType,
        groupKey,
        seriesIds: [],
      });
    }
    
    groups.get(groupKey)!.seriesIds.push(seriesId);
  }
  
  return groups;
}

/**
 * Get the consolidated series ID for a marker group
 * This will be used as the primary series ID for the group
 */
export function getConsolidatedSeriesId(group: MarkerGroup): string {
  // Use the first series ID in the group as the consolidated ID
  // Or create a canonical ID: "instrument:strategy:markers" or "instrument:strategy:signals"
  return `${group.instrument}:strategy:${group.strategy}:${group.markerType}`;
}

