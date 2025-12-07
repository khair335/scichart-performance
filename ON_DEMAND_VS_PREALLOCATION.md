# On-Demand vs Registry Preallocation Comparison

## ✅ **Verification: Both Methods Are Identical**

### **1. Capacity (Preallocation Size)**
- **Registry Preallocation:** Uses `getSeriesCapacity()` → `config.data.buffers.pointsPerSeries` (1M default)
- **On-Demand Creation:** Uses `getSeriesCapacity()` → `config.data.buffers.pointsPerSeries` (1M default)
- ✅ **MATCH:** Both use the same capacity from UI config

### **2. DataSeries Creation**
- **Registry Preallocation:** 
  ```typescript
  fifoCapacity: capacity,
  capacity: capacity,
  containsNaN: false,
  dataIsSortedInX: true,
  dataEvenlySpacedInX: false,
  ```
- **On-Demand Creation:**
  ```typescript
  fifoCapacity: capacity,
  capacity: capacity,
  containsNaN: false,
  dataIsSortedInX: true,
  dataEvenlySpacedInX: false,
  ```
- ✅ **MATCH:** Identical DataSeries configuration

### **3. RenderableSeries Configuration**
- **Registry Preallocation:**
  - Tick: `resamplingMode: EResamplingMode.None`
  - Indicators: `resamplingMode: EResamplingMode.Auto`
- **On-Demand Creation:**
  - Tick: `resamplingMode: EResamplingMode.None`
  - Indicators: `resamplingMode: EResamplingMode.Auto`
- ✅ **MATCH:** Identical resampling modes

### **4. Chart Target Assignment**
- **Registry Preallocation:** Uses `parseSeriesType()` to determine `chartTarget`
- **On-Demand Creation:** Uses `parseSeriesType()` to determine `chartTarget`
- ✅ **MATCH:** Same logic for routing series to correct chart

## ✅ **Conclusion: On-Demand Creation Matches Requirements**

The on-demand creation is **identical** to registry preallocation in all aspects:
- ✅ Same preallocation capacity (1M from config)
- ✅ Same DataSeries configuration
- ✅ Same RenderableSeries settings
- ✅ Same chart routing logic
- ✅ Same visibility handling

**The only difference is timing:**
- **Registry Preallocation:** Happens when registry discovers series (proactive)
- **On-Demand Creation:** Happens when data arrives before registry (reactive fallback)

Both methods create series with the **exact same configuration**, so there should be **no functional difference**.

---

## 🔍 **Wave Shape Difference Investigation**

If the wave shape is different, possible causes:

### **1. Resampling Mode**
- **Current:** `EResamplingMode.None` for tick series
- **Expected:** Pure sine waves without resampling artifacts
- **Check:** Verify `resamplingMode` is set correctly for tick series

### **2. Downsampling Ratio**
- **Current:** `BASE_DOWNSAMPLE_RATIO = 2` (2:1 downsampling)
- **Expected:** Smooth sine waves with 2:1 downsampling
- **Check:** Verify downsampling is applied consistently

### **3. Data Processing**
- **Current:** Unified store processes all series the same way
- **Expected:** Same processing for all series types
- **Check:** Verify data is appended correctly to DataSeries

### **4. Series Creation Timing**
- **On-Demand:** Series created when first data arrives
- **Registry:** Series created when registry updates
- **Impact:** Should be none, but timing might affect initial rendering

---

## 📋 **Recommendations**

1. **Verify Registry Preallocation is Working:**
   - Check console for: `[MultiPaneChart] Preallocated DataSeries for...`
   - If you see on-demand creation, registry preallocation might not be running
   - Registry preallocation should happen BEFORE data arrives

2. **Check Wave Shape Settings:**
   - Verify `resamplingMode: EResamplingMode.None` for tick series
   - Verify `BASE_DOWNSAMPLE_RATIO = 2` is being used
   - Check that data is being appended correctly

3. **Monitor Console Logs:**
   - Look for both "Preallocated" and "Created on-demand" messages
   - If you see mostly "on-demand", registry preallocation might need fixing
   - Ideally, you should see "Preallocated" messages first

---

## ✅ **Answer to User's Questions**

### **Q1: Will on-demand series creation cause issues that don't match requirements?**
**A:** No. On-demand creation uses the exact same configuration as registry preallocation:
- ✅ Same preallocation capacity (1M from config)
- ✅ Same DataSeries settings
- ✅ Same RenderableSeries configuration
- ✅ Same chart routing

The only difference is **timing** (reactive vs proactive), but the **result is identical**.

### **Q2: Wave shape is different - is this as per requirement?**
**A:** The wave shape should be the same. If it's different, possible causes:
1. **Resampling mode** might not be set correctly
2. **Downsampling ratio** might be different
3. **Data processing** might have changed

**Action:** Check console logs to see if series are being created via registry preallocation or on-demand. Both should produce the same wave shape, but if registry preallocation isn't running, we should fix that.




