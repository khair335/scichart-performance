# Deployment Guide

This guide covers deploying both the frontend (Vercel) and the WebSocket server (server.py).

## Frontend Deployment (Vercel)

### Prerequisites
- Vercel account
- GitHub/GitLab/Bitbucket repository (or Vercel CLI)

### Option 1: Deploy via Vercel Dashboard

1. **Connect Repository**
   - Go to [vercel.com](https://vercel.com)
   - Click "New Project"
   - Import your repository

2. **Configure Environment Variables**
   - In Project Settings → Environment Variables, add:
     ```
     VITE_WS_URL=wss://your-server-domain.com
     ```
   - Replace `your-server-domain.com` with your WebSocket server URL

3. **Deploy**
   - Vercel will automatically detect Vite and deploy
   - The build will use the `vercel.json` configuration

### Option 2: Deploy via Vercel CLI

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel

# Set environment variable
vercel env add VITE_WS_URL
# Enter: wss://your-server-domain.com

# Deploy to production
vercel --prod
```

### Important Notes

- **WebSocket URL**: Must use `wss://` (secure WebSocket) for production, not `ws://`
- **CORS**: Ensure your WebSocket server allows connections from your Vercel domain
- **Config Files**: The app will fall back to `/config.json` if `VITE_WS_URL` is not set

## WebSocket Server Deployment (server.py)

**⚠️ Important**: Vercel does NOT support WebSocket servers. You need to deploy `server.py` separately.

### Option 1: Railway (Recommended)

Railway is excellent for Python WebSocket servers.

1. **Install Railway CLI** (optional):
   ```bash
   npm i -g @railway/cli
   ```

2. **Deploy via Railway Dashboard**:
   - Go to [railway.app](https://railway.app)
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway will auto-detect Python

3. **Configure**:
   - Add `requirements.txt` (already created)
   - Set environment variables in Railway dashboard:
     ```
     PORT=8765
     HOST=0.0.0.0
     ```
   - Railway will provide a public URL like: `wss://your-app.railway.app`

4. **Update Vercel Environment Variable**:
   - Set `VITE_WS_URL=wss://your-app.railway.app` in Vercel

### Option 2: Render

1. **Create `render.yaml`** (see below)
2. Go to [render.com](https://render.com)
3. Create new "Web Service"
4. Connect repository
5. Render will use `render.yaml` for configuration

### Option 3: Fly.io

```bash
# Install Fly CLI
curl -L https://fly.io/install.sh | sh

# Login
fly auth login

# Launch app
fly launch

# Set secrets
fly secrets set HOST=0.0.0.0 PORT=8765

# Deploy
fly deploy
```

### Option 4: DigitalOcean App Platform

1. Go to DigitalOcean → App Platform
2. Create new app from GitHub
3. Select Python service
4. Configure:
   - Build command: `pip install -r requirements.txt`
   - Run command: `python server.py --host 0.0.0.0 --port $PORT`
   - Environment variables: Set as needed

### Option 5: AWS EC2 / VPS

For full control, deploy on a VPS:

```bash
# SSH into server
ssh user@your-server.com

# Install Python 3.9+
sudo apt update
sudo apt install python3 python3-pip

# Install dependencies
pip3 install -r requirements.txt

# Run with systemd (create /etc/systemd/system/wsfeed.service)
sudo nano /etc/systemd/system/wsfeed.service
```

**systemd service file** (`/etc/systemd/system/wsfeed.service`):
```ini
[Unit]
Description=WebSocket Feed Server
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/your/project
ExecStart=/usr/bin/python3 server.py --host 0.0.0.0 --port 8765
Restart=always

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable wsfeed
sudo systemctl start wsfeed

# Use nginx as reverse proxy for SSL
```

**Nginx reverse proxy** (for SSL/WSS):
```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 443 ssl;
    server_name your-domain.com;

    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:8765;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Quick Start: Railway + Vercel

### 1. Deploy Server (Railway)

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# Initialize
railway init

# Link to project
railway link

# Deploy
railway up
```

Railway will provide a URL like: `wss://your-app.up.railway.app`

### 2. Deploy Frontend (Vercel)

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Set WebSocket URL (replace with your Railway URL)
vercel env add VITE_WS_URL production
# Enter: wss://your-app.up.railway.app

# Deploy
vercel --prod
```

## Testing Deployment

1. **Test WebSocket Server**:
   ```bash
   # Run server locally
   python server.py --mode quick --port 8765
   
   # Test connection
   wscat -c ws://localhost:8765
   ```

2. **Test Frontend**:
   - Build locally: `npm run build`
   - Preview: `npm run preview`
   - Verify WebSocket connection in browser console

## Environment Variables Reference

### Frontend (Vercel)
- `VITE_WS_URL`: WebSocket server URL (e.g., `wss://server.example.com`)

### Server (Railway/Render/etc.)
- `HOST`: Server host (default: `127.0.0.1`, use `0.0.0.0` for production)
- `PORT`: Server port (default: `8765`)
- `MODE`: Server mode (`quick`, `session`, `db_live`, `db_playback`)
- `INSTRUMENT`: Instrument symbol (default: `ES.c.0`)
- `RING_CAPACITY`: Ring buffer capacity (default: `200000`)
- `WS_FORMAT`: Wire format (`text` or `binary`, default: `text`)

See `server.py --help` for all options.

## Troubleshooting

### Frontend can't connect to WebSocket
- ✅ Check `VITE_WS_URL` is set correctly in Vercel
- ✅ Ensure server URL uses `wss://` (not `ws://`) for HTTPS sites
- ✅ Verify CORS settings on server
- ✅ Check browser console for errors

### Server not starting
- ✅ Check Python version (3.9+)
- ✅ Verify `requirements.txt` dependencies installed
- ✅ Check server logs for errors
- ✅ Ensure port is not already in use

### Connection drops
- ✅ Check server logs for errors
- ✅ Verify network connectivity
- ✅ Check server resource limits (CPU/memory)

## Production Checklist

- [ ] WebSocket server deployed and accessible
- [ ] SSL certificate configured (for `wss://`)
- [ ] `VITE_WS_URL` set in Vercel environment variables
- [ ] CORS configured on server
- [ ] Server health monitoring set up
- [ ] Error logging configured
- [ ] Domain names configured (optional)

