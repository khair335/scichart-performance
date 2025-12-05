// SciChart Custom Theme Configuration
// Uses proper SciChart theme approach without custom registration

import { SciChartJsNavyTheme } from 'scichart';

// Dark theme based on SciChartJsNavyTheme with customizations
export const darkChartTheme = {
  ...new SciChartJsNavyTheme(),
  sciChartBackground: '#0f1419',
  loadingAnimationBackground: '#0f1419',
  loadingAnimationForeground: '#50C7E0',
  gridBackgroundBrush: 'transparent',
  gridBorderBrush: 'transparent',
  majorGridLineBrush: '#1e2a36',
  minorGridLineBrush: '#151d26',
  tickTextBrush: '#8b9eb0',
  axisTitleColor: '#9fb2c9',
  labelBackgroundBrush: '#1c2027',
  labelBorderBrush: '#3a424c',
  labelForegroundBrush: '#9fb2c9',
  cursorLineBrush: '#50C7E0',
  axisBandsFill: 'transparent',
  axisBorder: 'transparent',
};

// Light theme variant
export const lightChartTheme = {
  ...new SciChartJsNavyTheme(),
  sciChartBackground: '#ffffff',
  loadingAnimationBackground: '#ffffff',
  loadingAnimationForeground: '#2563eb',
  gridBackgroundBrush: 'transparent',
  gridBorderBrush: 'transparent',
  majorGridLineBrush: '#e5e7eb',
  minorGridLineBrush: '#f3f4f6',
  tickTextBrush: '#4b5563',
  axisTitleColor: '#374151',
  labelBackgroundBrush: '#ffffff',
  labelBorderBrush: '#d1d5db',
  labelForegroundBrush: '#374151',
  cursorLineBrush: '#2563eb',
  axisBandsFill: 'transparent',
  axisBorder: 'transparent',
};

// Get theme by name
export function getChartTheme(theme: 'dark' | 'light') {
  return theme === 'dark' ? darkChartTheme : lightChartTheme;
}
