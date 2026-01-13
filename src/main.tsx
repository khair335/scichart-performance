import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

// Install global crash monitoring hooks (console tap + window.onerror)
// to capture SciChart/WASM errors that may not propagate to React.
import { installSciChartCrashHooks } from "@/lib/scichart-crash-hooks";

installSciChartCrashHooks();

createRoot(document.getElementById("root")!).render(<App />);
