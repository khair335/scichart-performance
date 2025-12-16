// Here's a detailed example outline for using the SubCharts API with a minimap in React, syncing specific panes (subcharts) and a custom select box for axis range:
import React, { useEffect, useRef, useState } from "react";
import {
 SciChartSurface,
 NumericAxis,
 XyDataSeries,
 FastLineRenderableSeries,
 SubChart,
 EAxisType,
} from "scichart";

function SubChartWithMinimap() {
 const mainChartRef = useRef(null);
 const minimapRef = useRef(null);
 const [axisRange, setAxisRange] = useState({ min: 0, max: 100 });

 useEffect(() => {
 async function init() {
 // 1. Create main SciChartSurface with SubCharts (multiple panes)
 const { sciChartSurface: mainSurface, wasmContext: mainWasmContext } = await SciChartSurface.create("main-chart");

 // Add subcharts (panes) to mainSurface
 // Example: 3 panes vertically stacked
 const pane1 = mainSurface.addSubChart({ height: 0.5 }); // 50% height
 const pane2 = mainSurface.addSubChart({ height: 0.3 }); // 30% height
 const pane3 = mainSurface.addSubChart({ height: 0.2 }); // 20% height

 // Add X and Y axes to each pane
 [pane1, pane2, pane3].forEach((pane) => {
 pane.xAxes.add(new NumericAxis(mainWasmContext, { axisType: EAxisType.X }));
 pane.yAxes.add(new NumericAxis(mainWasmContext, { axisType: EAxisType.Y }));
 });

 // Add data series to each pane (example data)
 pane1.renderableSeries.add(
 new FastLineRenderableSeries(mainWasmContext, {
 dataSeries: new XyDataSeries(mainWasmContext, { xValues: [0, 50, 100], yValues: [10, 50, 10] }),
 })
 );
 pane2.renderableSeries.add(
 new FastLineRenderableSeries(mainWasmContext, {
 dataSeries: new XyDataSeries(mainWasmContext, { xValues: [0, 50, 100], yValues: [20, 40, 20] }),
 })
 );
 pane3.renderableSeries.add(
 new FastLineRenderableSeries(mainWasmContext, {
 dataSeries: new XyDataSeries(mainWasmContext, { xValues: [0, 50, 100], yValues: [5, 25, 5] }),
 })
 );

 mainChartRef.current = { surface: mainSurface, panes: [pane1, pane2, pane3] };

 // 2. Create minimap SciChartSurface with only selected panes (e.g. pane1 and pane3)
 const { sciChartSurface: miniSurface, wasmContext: miniWasmContext } = await SciChartSurface.create("minimap-chart");

 // Add only pane1 and pane3 to minimap
 const miniPane1 = miniSurface.addSubChart({ height: 0.7 });
 const miniPane3 = miniSurface.addSubChart({ height: 0.3 });

 [miniPane1, miniPane3].forEach((pane) => {
 pane.xAxes.add(new NumericAxis(miniWasmContext, { axisType: EAxisType.X }));
 pane.yAxes.add(new NumericAxis(miniWasmContext, { axisType: EAxisType.Y }));
 });

 // Add same data series to minimap panes
 miniPane1.renderableSeries.add(
 new FastLineRenderableSeries(miniWasmContext, {
 dataSeries: new XyDataSeries(miniWasmContext, { xValues: [0, 50, 100], yValues: [10, 50, 10] }),
 })
 );
 miniPane3.renderableSeries.add(
 new FastLineRenderableSeries(miniWasmContext, {
 dataSeries: new XyDataSeries(miniWasmContext, { xValues: [0, 50, 100], yValues: [5, 25, 5] }),
 })
 );

 minimapRef.current = { surface: miniSurface, panes: [miniPane1, miniPane3] };

 // 3. Sync visibleRange of X axes between main chart panes and minimap panes for selected panes
 // Helper function to sync two axes bidirectionally
 function syncAxes(mainAxis, miniAxis) {
 let syncing = false;
 mainAxis.visibleRangeChanged.subscribe(() => {
 if (syncing) return;
 syncing = true;
 miniAxis.visibleRange = mainAxis.visibleRange;
 syncing = false;
 setAxisRange({ min: mainAxis.visibleRange.min, max: mainAxis.visibleRange.max });
 });
 miniAxis.visibleRangeChanged.subscribe(() => {
 if (syncing) return;
 syncing = true;
 mainAxis.visibleRange = miniAxis.visibleRange;
 syncing = false;
 setAxisRange({ min: miniAxis.visibleRange.min, max: miniAxis.visibleRange.max });
 });
 }

 // Sync pane1 X axes
 syncAxes(pane1.xAxes.get(0), miniPane1.xAxes.get(0));
 // Sync pane3 X axes
 syncAxes(pane3.xAxes.get(0), miniPane3.xAxes.get(0));

 // Initialize visibleRange
 const initialRange = { min: 0, max: 100 };
 [pane1, pane3].forEach((pane) => (pane.xAxes.get(0).visibleRange = initialRange));
 [miniPane1, miniPane3].forEach((pane) => (pane.xAxes.get(0).visibleRange = initialRange));
 }

 init();

 return () => {
 mainChartRef.current?.surface.delete();
 minimapRef.current?.surface.delete();
 };
 }, []);

 // 4. Custom select box to update visibleRange on synced panes
 const onRangeChange = (e) => {
 const [min, max] = e.target.value.split(",").map(Number);
 setAxisRange({ min, max });
 if (mainChartRef.current && minimapRef.current) {
 // Update visibleRange on synced panes only (pane1 and pane3)
 [mainChartRef.current.panes[0], mainChartRef.current.panes[2]].forEach((pane) => {
 pane.xAxes.get(0).visibleRange = { min, max };
 });
 [minimapRef.current.panes[0], minimapRef.current.panes[1]].forEach((pane) => {
 pane.xAxes.get(0).visibleRange = { min, max };
 });
 }
 };

 return (
 <>
 <select onChange={onRangeChange} value={`${axisRange.min},${axisRange.max}`}>
 <option value="0,50">0 to 50</option>
 <option value="25,75">25 to 75</option>
 <option value="50,100">50 to 100</option>
 </select>
 <div id="main-chart" style={{ width: "600px", height: "400px" }}></div>
 <div id="minimap-chart" style={{ width: "600px", height: "150px", marginTop: "10px" }}></div>
 </>
 );
}

export default SubChartWithMinimap;

// Summary:

// Use addSubChart() to create panes in both main and minimap surfaces.
// Add axes and series to each pane.
// Sync visibleRange of X axes for only the panes you want to show in the minimap.
// Use event subscriptions to keep visibleRanges in sync bidirectionally.
// Update visibleRange from your custom select box on synced panes in both charts.

as soon as I select the axis range why it is reasitting automatically? does minimap doing anything to reset automatically? also I see you have added X asix numbers in minimap, I did't said that for range, I said a range indicatior that sci chart have defult, like a range which I can drag and slide left right like slider, and minimap should show the entire all data that plotted in main chart at a time