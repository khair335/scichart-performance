
import { createRoot, hydrateRoot } from "react-dom/client";

import { SciChartSurface, SciChart3DSurface } from "scichart";

import App from "./App";

const rootElement = document.getElementById("root");

SciChartSurface.UseCommunityLicense();
SciChartSurface.loadWasmFromCDN();
SciChart3DSurface.loadWasmFromCDN();

const root = createRoot(rootElement)
root.render(<><App /><a href="https://www.scichart.com" target="_blank" rel="noopener noreferrer">Created with Scichart.js High Performance Javascript Charts</a></>);
