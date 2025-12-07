# Project File Structure

## Root Directory

```
scichart-performance-main/
├── 📄 Configuration Files
│   ├── package.json                    # Node.js dependencies and scripts
│   ├── tsconfig.json                   # TypeScript configuration
│   ├── tsconfig.app.json               # TypeScript app config
│   ├── tsconfig.node.json              # TypeScript node config
│   ├── vite.config.ts                 # Vite build configuration
│   ├── tailwind.config.ts             # Tailwind CSS configuration
│   ├── postcss.config.js              # PostCSS configuration
│   ├── eslint.config.js               # ESLint configuration
│   ├── components.json                # shadcn/ui components config
│   └── index.html                     # Main HTML entry point
│
├── 📄 Configuration Data Files
│   ├── config.json                    # Startup configuration (WebSocket URL, theme, etc.)
│   ├── layout-example.json            # Example JSON layout file
│   ├── layout-example-2.json          # Alternative layout example
│   └── server.py                      # Python WebSocket server for testing
│
├── 📄 Documentation Files
│   ├── README.md                      # Project readme
│   ├── PROJECT.REQUIREMENTS (3).md    # Requirements document (version 3)
│   ├── PROJECT_IMPLEMENTATION_SUMMARY.md  # Current implementation summary
│   ├── PROJECT_FILE_STRUCTURE.md      # This file
│   ├── DATA.NAMESPACE.md              # Data namespace specification
│   ├── UI_CONFIG_COMPARISON.md        # UI config comparison
│   ├── VERIFICATION_RESULTS.md        # Verification test results
│   ├── VERIFY_SETTINGS.md             # Settings verification
│   ├── ON_DEMAND_VS_PREALLOCATION.md # Preallocation strategy docs
│   ├── TEST_CASES.md                  # Test cases documentation
│   ├── PIPELINE_STATUS.md             # Data pipeline status
│   ├── INGESTION_PIPELINE_REFACTOR.md # Pipeline refactoring notes
│   ├── IMPLEMENTATION_STATUS.md       # Implementation status
│   └── BACKGROUND_PROCESSING_EXPLANATION.md  # Background processing docs
│
├── 📁 public/                         # Static assets served at root
│   ├── config.json                    # Startup config (loaded at runtime)
│   ├── ui-config.json                 # UI configuration (loaded at runtime)
│   ├── favicon.ico                    # Site favicon
│   ├── placeholder.svg                # Placeholder image
│   └── robots.txt                     # Robots.txt file
│
├── 📁 src/                            # Source code directory
│   ├── main.tsx                       # React application entry point
│   ├── App.tsx                        # Main App component
│   ├── index.css                      # Global CSS styles
│   ├── vite-env.d.ts                  # Vite type definitions
│   │
│   ├── 📁 pages/                      # Page components
│   │   ├── Index.tsx                  # Main chart page (loads config, renders TradingChart)
│   │   └── NotFound.tsx               # 404 page
│   │
│   ├── 📁 components/                 # React components
│   │   ├── NavLink.tsx                # Navigation link component
│   │   │
│   │   ├── 📁 chart/                  # Chart-specific components
│   │   │   ├── TradingChart.tsx      # Main chart orchestrator component
│   │   │   ├── MultiPaneChart.tsx    # Core chart engine hook (~2,500 lines)
│   │   │   ├── ChartPane.tsx          # Individual chart pane component
│   │   │   ├── HUD.tsx                # Heads-Up Display component
│   │   │   ├── Toolbar.tsx            # Toolbar with controls
│   │   │   ├── SeriesBrowser.tsx     # Series visibility drawer
│   │   │   └── CommandPalette.tsx    # Command palette (Ctrl/Cmd+K)
│   │   │
│   │   └── 📁 ui/                    # shadcn/ui components (40+ files)
│   │       ├── button.tsx
│   │       ├── dialog.tsx
│   │       ├── drawer.tsx
│   │       ├── input.tsx
│   │       ├── select.tsx
│   │       ├── switch.tsx
│   │       ├── tabs.tsx
│   │       ├── tooltip.tsx
│   │       └── ... (many more UI components)
│   │
│   ├── 📁 hooks/                      # Custom React hooks
│   │   ├── useWebSocketFeed.ts        # WebSocket feed hook
│   │   ├── useDemoDataGenerator.ts     # Demo data generator hook
│   │   ├── useSciChart.ts             # SciChart initialization hook
│   │   ├── use-mobile.tsx             # Mobile detection hook
│   │   └── use-toast.ts               # Toast notification hook
│   │
│   ├── 📁 lib/                        # Utility libraries
│   │   ├── wsfeed-client.ts           # WebSocket feed client (universal)
│   │   ├── series-namespace.ts         # Series type parsing utilities
│   │   └── utils.ts                   # General utility functions
│   │
│   └── 📁 types/                      # TypeScript type definitions
│       └── chart.ts                   # Chart-related type definitions
│
├── 📁 dist/                           # Build output directory (generated)
│   ├── index.html
│   ├── assets/
│   ├── config.json
│   ├── ui-config.json
│   └── ...
│
├── 📁 node_modules/                   # Node.js dependencies (generated)
│   └── ... (hundreds of packages)
│
└── 📄 Lock Files
    ├── package-lock.json              # npm lock file
    ├── yarn.lock                      # Yarn lock file
    └── bun.lockb                      # Bun lock file
```

---

## Key File Descriptions

### Core Application Files

#### `src/pages/Index.tsx`
- **Purpose**: Application entry point
- **Responsibilities**:
  - Loads `config.json` and `ui-config.json` on startup
  - Renders `TradingChart` component
  - Handles loading states

#### `src/components/chart/TradingChart.tsx`
- **Purpose**: Main chart orchestrator
- **Responsibilities**:
  - Manages application state (theme, minimap, series visibility, live mode, FPS, metrics)
  - Integrates WebSocket feed and demo data generator
  - Renders UI components: Toolbar, HUD, Series Browser, Command Palette
  - Coordinates chart initialization and data flow

#### `src/components/chart/MultiPaneChart.tsx`
- **Purpose**: Core chart rendering engine
- **Size**: ~2,500 lines
- **Responsibilities**:
  - Initializes SciChart surfaces (Tick and OHLC charts)
  - Manages unified DataSeries store
  - Handles real-time data ingestion, batching, and rendering
  - Implements X/Y axis management, auto-scroll, auto-scaling
  - Handles tab visibility, background processing
  - Performance optimizations (downsampling, batching, throttling)

### Data Pipeline Files

#### `src/lib/wsfeed-client.ts`
- **Purpose**: Universal WebSocket feed client
- **Responsibilities**:
  - WebSocket connection management
  - Sequence number deduplication
  - Feed stage tracking (idle, history, delta, live)
  - Data registry management
  - Status updates and error recovery

#### `src/hooks/useWebSocketFeed.ts`
- **Purpose**: React hook wrapper for WebSocket feed
- **Responsibilities**:
  - Manages WebSocket connection lifecycle
  - Provides feed state and registry to components
  - Handles sample callbacks

### Series Management Files

#### `src/lib/series-namespace.ts`
- **Purpose**: Series type parsing and routing
- **Responsibilities**:
  - Parses `series_id` to determine type (tick, OHLC, indicator, strategy)
  - Routes series to correct chart (tick or OHLC)
  - Provides display type names for UI
  - No hardcoded assumptions about indicator types

### UI Component Files

#### `src/components/chart/HUD.tsx`
- **Purpose**: Heads-Up Display
- **Displays**: FPS, data rate, lag, tick count, CPU%, memory, GPU metrics, feed stage, history progress, data clock

#### `src/components/chart/Toolbar.tsx`
- **Purpose**: Chart toolbar
- **Features**: Live/pause toggle, zoom controls, minimap toggle, series browser, theme toggle, command palette

#### `src/components/chart/SeriesBrowser.tsx`
- **Purpose**: Series visibility management drawer
- **Features**: Lists all discovered series, toggle visibility, select all/none, grouped by type

#### `src/components/chart/CommandPalette.tsx`
- **Purpose**: Command palette for quick actions
- **Shortcut**: Ctrl/Cmd+K
- **Features**: Fuzzy search, quick actions (jump to live, zoom extents, etc.)

### Configuration Files

#### `public/config.json`
- **Purpose**: Startup configuration
- **Contains**: WebSocket URL, theme preference, performance settings

#### `public/ui-config.json`
- **Purpose**: UI configuration
- **Contains**:
  - Transport settings (WebSocket URL, binary mode)
  - Ingest settings (target transfer rate, batch size)
  - Data buffer settings (preallocation size, global cap)
  - Performance settings (FPS, downsampling, batching)
  - Chart settings (X-axis separation, auto-scroll, timezone)
  - Data collection settings (background buffer size)
  - Minimap settings
  - UI theme settings

### Documentation Files

#### `PROJECT.REQUIREMENTS (3).md`
- **Purpose**: Client requirements specification
- **Contains**: All feature requirements, performance targets, technical specifications

#### `PROJECT_IMPLEMENTATION_SUMMARY.md`
- **Purpose**: Comprehensive implementation summary
- **Contains**: Current implementation details, architecture, features, limitations

#### `DATA.NAMESPACE.md`
- **Purpose**: Data namespace specification
- **Contains**: Series ID patterns, naming conventions, routing rules

---

## File Size Summary

### Largest Files
1. **`src/components/chart/MultiPaneChart.tsx`**: ~2,500 lines (core chart engine)
2. **`src/lib/wsfeed-client.ts`**: ~350 lines (WebSocket client)
3. **`src/components/chart/TradingChart.tsx`**: ~500 lines (main orchestrator)
4. **`src/lib/series-namespace.ts`**: ~160 lines (series parsing)

### Component Count
- **Chart Components**: 7 files
- **UI Components**: 40+ files (shadcn/ui)
- **Hooks**: 5 files
- **Libraries**: 3 files
- **Pages**: 2 files
- **Types**: 1 file

---

## Build & Output

### Build Process
- **Build Tool**: Vite
- **Output Directory**: `dist/`
- **Entry Point**: `src/main.tsx`
- **HTML Template**: `index.html`

### Generated Files
- `dist/index.html` - Built HTML
- `dist/assets/` - Bundled JavaScript and CSS
- `dist/config.json` - Copied config files
- `dist/ui-config.json` - Copied UI config

---

## Dependencies

### Major Libraries
- **React**: UI framework
- **SciChart**: Charting library (WebAssembly)
- **React Router**: Routing
- **Tailwind CSS**: Styling
- **shadcn/ui**: UI component library
- **TypeScript**: Type safety

### Development Tools
- **Vite**: Build tool and dev server
- **ESLint**: Code linting
- **TypeScript**: Type checking
- **PostCSS**: CSS processing

---

## Notes

- All source code is in TypeScript (`.ts` or `.tsx`)
- Configuration files are JSON
- Documentation is Markdown (`.md`)
- Build output goes to `dist/` directory
- Static assets are in `public/` directory
- UI components follow shadcn/ui patterns
- Chart components are custom-built for this project




