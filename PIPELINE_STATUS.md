# Data Ingestion Pipeline Status

## ✅ **COMPLETED**

### 1. **UI Config JSON Structure** ✅
- **File:** `public/ui-config.json`
- **Structure:** Updated to match requirements
  - `data.buffers.pointsPerSeries: 1000000` (default preallocation)
  - `data.buffers.maxPointsTotal: 10000000` (global cap)
  - `chart.timezone: "UTC"` (for DateTime axes)
  - `transport`, `ingest`, `uiDrain` sections added
- **Status:** ✅ Complete

### 2. **Unified DataSeries Store Structure** ✅
- **Interface:** `DataSeriesEntry` defined
- **Store:** `dataSeriesStore: Map<string, DataSeriesEntry>` in ChartRefs
- **Status:** ✅ Structure defined, but not fully integrated yet

### 3. **Registry-Based Preallocation** ✅
- **Listener:** `useEffect` that watches `registry` prop
- **Preallocation:** Creates DataSeries when new series discovered
- **Capacity:** Uses `config.data.buffers.pointsPerSeries` (1M default)
- **Status:** ✅ Implemented (lines 711-789)

### 4. **Config Helper** ✅
- **Function:** `getSeriesCapacity()` returns preallocation size
- **Legacy Support:** Maps old `dataBuffers` structure to new `data.buffers`
- **Status:** ✅ Complete

---

## ⚠️ **PARTIALLY IMPLEMENTED / NEEDS REFACTORING**

### 1. **Data Processing Still Uses Old Structure**
- **Current:** Still references `refs.tickDataSeries`, `refs.ohlcDataSeries`, separate Maps
- **Should be:** Use `refs.dataSeriesStore.get(series_id)` for all series
- **Location:** `processBatchedSamples()` function (line 732+)
- **Status:** ⚠️ Needs refactoring

### 2. **Initial Chart Setup Still Creates Hardcoded Series**
- **Current:** Creates `tickDataSeries` and `ohlcDataSeries` during initialization
- **Should be:** Let registry preallocation create all series dynamically
- **Location:** Chart initialization (lines 360-453)
- **Status:** ⚠️ Needs refactoring

### 3. **ChartRefs Initialization Mismatch**
- **Current:** ChartRefs structure updated, but initialization still uses old fields
- **Location:** Line 130+ (chartRefs initialization) and line 520+ (store assignment)
- **Status:** ⚠️ Needs fixing

---

## 📋 **PIPELINE FLOW (Current vs Target)**

### **Current Pipeline:**
```
WS Feed → appendSamples() → sampleBufferRef → processBatchedSamples() 
  → Hardcoded tickDataSeries/ohlcDataSeries + separate Maps for indicators
```

### **Target Pipeline:**
```
WS Feed → appendSamples() → sampleBufferRef → processBatchedSamples()
  → Unified dataSeriesStore.get(series_id) → DataSeries.append()
```

### **Registry Preallocation (Already Working):**
```
Registry Update → useEffect → Preallocate DataSeries → Add to dataSeriesStore
  → Add RenderableSeries to appropriate chart surface
```

---

## 🔧 **NEXT STEPS**

1. **Refactor `processBatchedSamples()`** to use unified store
2. **Remove hardcoded tick/OHLC creation** from initialization
3. **Update ChartRefs initialization** to match new structure
4. **Test that all series types work** (tick, OHLC, indicators, strategy)

---

## ✅ **WHAT'S WORKING NOW**

- ✅ UI config loaded and structured correctly
- ✅ Registry listener preallocates buffers when series discovered
- ✅ Preallocation uses config value (1M points default)
- ✅ Unified store structure defined
- ✅ Visibility sync works with unified store

---

## ⚠️ **WHAT NEEDS FIXING**

- ⚠️ Data processing still uses old hardcoded structure
- ⚠️ Initial chart setup creates hardcoded series (should be dynamic)
- ⚠️ ChartRefs initialization doesn't match new structure

**The preallocation is working, but data ingestion still uses the old code paths.**

