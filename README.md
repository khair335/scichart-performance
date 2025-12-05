# SciChart Real-Time Trading Terminal

A high-performance real-time charting application built with React, Vite, and SciChart JS, powered by a Python WebSocket server.

## Quick Start (Local Development)

### Step 1 – Run static HTTP server (Terminal A)

From the directory where `index.html` and `wsfeed-client.js` live:

```bash
python -m http.server 8080
```

Or use Vite dev server:

```bash
npm install
npm run dev
```

* This serves the app at:
  `http://127.0.0.1:8080/index.html` (or `http://localhost:8080` with Vite)

### Step 2 – Run WebSocket server (Terminal B)

Random Walk:

```powershell
python server.py `
    --mode session `
    --instrument MESU5 `
    --session-ms 23400000 `
    --tick-dt-ms 25 `
    --indicator-windows "10,20,30,40,50,60,70,80,90" `
    --bar-intervals "10000,30000" `
    --strategy-rate-per-min 2 `
    --strategy-hold-bars 5 `
    --strategy-max-open 3 `
    --total-samples 12000000 `
    --ring-capacity 12000000 `
    --live-batch 2048 `
    --emit-samples-per-sec 20000 `
    --ws-format text `
    --price-model randomwalk
```
and Sine Wave:

```powershell
python server.py `
    --mode session `
    --instrument MESU5 `
    --session-ms 23400000 `
    --tick-dt-ms 25 `
    --indicator-windows "10,20,30,40,50,60,70,80,90" `
    --bar-intervals "10000,30000" `
    --strategy-rate-per-min 2 `
    --strategy-hold-bars 5 `
    --strategy-max-open 3 `
    --total-samples 12000000 `
    --ring-capacity 12000000 `
    --live-batch 2048 `
    --emit-samples-per-sec 20000 `
    --ws-format text `
    --price-model sine `
    --sine-period-sec 60
```

## Deployment

### Frontend (Vercel)

The frontend can be deployed to Vercel. See [DEPLOYMENT.md](./DEPLOYMENT.md) for detailed instructions.

**Quick deploy:**
```bash
# Install Vercel CLI
npm i -g vercel

# Login and deploy
vercel login
vercel --prod

# Set WebSocket server URL
vercel env add VITE_WS_URL production
# Enter: wss://your-server-domain.com
```

### WebSocket Server

**⚠️ Important**: The Python WebSocket server (`server.py`) cannot run on Vercel. You must deploy it separately.

**Recommended options:**
- **Railway** (easiest) - See [DEPLOYMENT.md](./DEPLOYMENT.md)
- **Render** - Uses `render.yaml` config
- **Fly.io** - Great for global distribution
- **AWS EC2 / VPS** - Full control

See [DEPLOYMENT.md](./DEPLOYMENT.md) for complete deployment guide with all options.

## Project Structure

- `src/` - React frontend source code
- `server.py` - Python WebSocket feed server
- `public/` - Static assets and config files
- `vercel.json` - Vercel deployment configuration
- `requirements.txt` - Python server dependencies
- `DEPLOYMENT.md` - Complete deployment guide