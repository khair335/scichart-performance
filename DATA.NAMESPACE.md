## 3. Sample Envelope (Universal Across Types)

Every data point — tick, bar, indicator, signal, fill, PnL — uses the same core structure:

```json
{
  "seq": 12345,
  "series_seq": 101,
  "series_id": "ES.c.0:ticks",
  "t_ms": 1761976864440,
  "payload": { /* type-specific */ }
}
```

* `seq` — **global** counter for ordering / resume / dedupe.
* `series_seq` — **per series** counter for **gap / missed detection**:

    * Starts at `1` for the first sample of a given `series_id`.
    * Increments by `1` for each subsequent sample of that series.
* `series_id` — routing key for the UI; defines *what* this sample is.
* `t_ms` — real or logical event timestamp in ms since epoch.
* `payload` — type-specific dictionary.

> **Note**
> `series_seq` is optional from the POV of a generic client, but the provided `server.py` and `wsfeed-client.js` **do emit and use it** for integrity tracking.

---

## 4. Series ID Namespacing

Use a simple, future‑proof pattern:

```text
<instrument>:<kind>[:qualifiers...]
```

**Common forms**

| Purpose                     | Example                         |
| --------------------------- | ------------------------------- |
| Tick                        | `ES.c.0:ticks`                  |
| Tick indicator              | `ES.c.0:sma_10`                 |
| Time bar                    | `ES.c.0:ohlc_time:10000`        |
| Bar indicator               | `ES.c.0:ohlc_time:10000:rsi`    |
| Strategy signals (intent)   | `ES.c.0:strategy:alpha:signals` |
| Strategy markers (executed) | `ES.c.0:strategy:alpha:markers` |
| Strategy PnL                | `ES.c.0:strategy:alpha:pnl`     |

**Semantics**

* **Signals** → what the strategy *wanted* to do.
* **Markers** → what actually executed (fills).
* **PnL** → cumulative realized equity curve.
* **Bar indicators** are nested under the bar series namespace, e.g. `ohlc_time:10000:rsi`.

**Bar timestamps**

For time bars (`ohlc_time:10000` etc.), `t_ms` is the **bar close** (TradingView‑style).

---

## 5. Payload Shapes

All examples below include **both** `seq` and `series_seq` to make the per‑series integrity rules explicit.

### 5.1 Tick

```json
{
  "seq": 101,
  "series_seq": 1,
  "series_id": "ES.c.0:ticks",
  "t_ms": 1761976854123,
  "payload": { "price": 6099.25, "volume": 1.0 }
}
```

---

### 5.2 Tick indicator

```json
{
  "seq": 102,
  "series_seq": 1,
  "series_id": "ES.c.0:sma_10",
  "t_ms": 1761976854123,
  "payload": { "value": 6099.18 }
}
```

> During warm‑up, indicator values may be `null`; map `null → NaN` before appending to SciChart.

---

### 5.3 Time bar (OHLC)

```json
{
  "seq": 201,
  "series_seq": 17,
  "series_id": "ES.c.0:ohlc_time:10000",
  "t_ms": 1761976860000,
  "payload": { "o": 6098.75, "h": 6100.00, "l": 6097.75, "c": 6099.25 }
}
```

---

### 5.4 Bar-based indicator

```json
{
  "seq": 301,
  "series_seq": 17,
  "series_id": "ES.c.0:ohlc_time:10000:rsi",
  "t_ms": 1761976860000,
  "payload": { "value": 54.1 }
}
```

---

### 5.5 Strategy markers — executed fills

**Used for actual trades (partial or full).**

```json
{
  "seq": 401,
  "series_seq": 3,
  "series_id": "ES.c.0:strategy:alpha:markers",
  "t_ms": 1761976863500,
  "payload": {
    "strategy": "alpha",
    "side": "long",
    "tag": "entry",
    "price": 6101.25,
    "qty": 3
  }
}
```

Notes:

* Emit **one marker per fill** OR aggregate into a single marker with total `qty` and VWAP.
* Partial fills are allowed (multiple `entry` events).
* Cancelled orders are optional (e.g. `tag: "cancel"`), depending on UI needs.

---

### 5.6 Strategy PnL (equity curve)

```json
{
  "seq": 501,
  "series_seq": 5,
  "series_id": "ES.c.0:strategy:alpha:pnl",
  "t_ms": 1761976882001,
  "payload": { "value": 350.75 }
}
```

Recommended: **cumulative realized PnL vs `t_ms`**.

---

### 5.7 Strategy signals — intent

```json
{
  "seq": 601,
  "series_seq": 4,
  "series_id": "ES.c.0:strategy:alpha:signals",
  "t_ms": 1761976863000,
  "payload": {
    "strategy": "alpha",
    "side": "long",
    "desired_qty": 5,
    "price": 6100.50,
    "reason": "cumsum>threshold"
  }
}
```

Signals show **what the strategy wanted to do**, independent of what was actually filled.
UI suggestion: signals as **hollow markers**, fills as **solid markers**.

---

## 6. Mixed Frame Example

```json
{
  "type": "live",
  "samples": [
    {
      "seq": 10001,
      "series_seq": 1001,
      "series_id": "ES.c.0:ticks",
      "t_ms": 1761976865200,
      "payload": { "price": 6099.75, "volume": 1.2 }
    },
    {
      "seq": 10002,
      "series_seq": 1001,
      "series_id": "ES.c.0:sma_10",
      "t_ms": 1761976865200,
      "payload": { "value": 6099.68 }
    },
    {
      "seq": 10003,
      "series_seq": 101,
      "series_id": "ES.c.0:ohlc_time:10000",
      "t_ms": 1761976870000,
      "payload": { "o": 6098.75, "h": 6100.0, "l": 6097.75, "c": 6099.25 }
    },
    {
      "seq": 10004,
      "series_seq": 101,
      "series_id": "ES.c.0:ohlc_time:10000:rsi",
      "t_ms": 1761976870000,
      "payload": { "value": 54.1 }
    },
    {
      "seq": 10005,
      "series_seq": 6,
      "series_id": "ES.c.0:strategy:alpha:markers",
      "t_ms": 1761976865321,
      "payload": {
        "strategy": "alpha",
        "side": "long",
        "tag": "entry",
        "price": 6100.25,
        "qty": 1
      }
    },
    {
      "seq": 10006,
      "series_seq": 6,
      "series_id": "ES.c.0:strategy:alpha:pnl",
      "t_ms": 1761976882001,
      "payload": { "value": 350.75 }
    }
  ]
}
```

Notes:

* `seq` is **global** and strictly monotonic across all series.
* `series_seq` is **per `series_id`** and strictly monotonic within that series only.
* Client dedupes by **global `seq`**, but integrity checks use **per‑series `series_seq`**.
