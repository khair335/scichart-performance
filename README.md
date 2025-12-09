# Step 1 – Run static HTTP server (Terminal A)

From the directory where `index.html` and `wsfeed-client.js` live:

```bash
python -m http.server 8080
````

* This serves `index.html` at:
  `http://127.0.0.1:8080/index.html`

### Step 2 – Run WebSocket server (Terminal B)

Random Walk:

**PowerShell:**
```powershell
python server.py `
    --mode session `
    --instrument MESU5 `
    --session-ms 23400000 `
    --tick-hz 40 `
    --indicator-windows "10,20,30,40,50,60,70,80,90" `
    --bar-intervals "10000,30000" `
    --strategy-rate-per-min 2 `
    --strategy-hold-bars 5 `
    --strategy-max-open 3 `
    --total-samples 12000000 `
    --ring-capacity 12000000 `
    --live-batch 2048 `
    --price-model randomwalk
```

**Bash:**
```bash
python server.py \
    --mode session \
    --instrument MESU5 \
    --session-ms 23400000 \
    --tick-hz 40 \
    --indicator-windows "10,20,30,40,50,60,70,80,90" \
    --bar-intervals "10000,30000" \
    --strategy-rate-per-min 2 \
    --strategy-hold-bars 5 \
    --strategy-max-open 3 \
    --total-samples 12000000 \
    --ring-capacity 12000000 \
    --live-batch 2048 \
    --price-model randomwalk
```

Sine Wave:

**PowerShell:**
```powershell
python server.py `
    --mode session `
    --instrument MESU5 `
    --session-ms 23400000 `
    --tick-hz 25 `
    --indicator-windows "10,20,30,40,50" `
    --bar-intervals "10000,30000" `
    --strategy-rate-per-min 2 `
    --strategy-hold-bars 5 `
    --strategy-max-open 3 `
    --total-samples 12000000 `
    --ring-capacity 12000000 `
    --live-batch 1024 `
    --price-model sine `
    --sine-period-sec 60
```

**Bash:**
```bash
python server.py \
    --mode session \
    --instrument MESU5 \
    --session-ms 23400000 \
    --tick-hz 40 \
    --indicator-windows "10,20,30,40,50,60,70,80,90" \
    --bar-intervals "10000,30000" \
    --strategy-rate-per-min 2 \
    --strategy-hold-bars 5 \
    --strategy-max-open 3 \
    --total-samples 12000000 \
    --ring-capacity 12000000 \
    --live-batch 2048 \
    --price-model sine \
    --sine-period-sec 60
```

### Multiple Instruments (ESU5 and MESU5):

**PowerShell:**
```powershell
python server.py `
    --mode session `
    --instrument ESU5,MESU5 `
    --session-ms 23400000 `
    --tick-hz 40 `
    --indicator-windows "10,20,30,40,50,60,70,80,90" `
    --bar-intervals "10000,30000" `
    --strategy-rate-per-min 2 `
    --strategy-hold-bars 5 `
    --strategy-max-open 3 `
    --total-samples 12000000 `
    --ring-capacity 12000000 `
    --live-batch 2048 `
    --price-model sine `
    --sine-period-sec 60
```

**Bash:**
```bash
python3 server.py \
    --mode session \
    --instrument ESU5,MESU5 \
    --session-ms 23400000 \
    --tick-hz 40 \
    --indicator-windows "10,20,30,40,50,60,70,80,90" \
    --bar-intervals "10000,30000" \
    --strategy-rate-per-min 2 \
    --strategy-hold-bars 5 \
    --strategy-max-open 3 \
    --total-samples 12000000 \
    --ring-capacity 12000000 \
    --live-batch 2048 \
    --price-model sine \
    --sine-period-sec 60
```