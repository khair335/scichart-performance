# Quick Deployment Guide

## 🚀 Fastest Way to Deploy

### 1. Deploy Server (Railway) - 5 minutes

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# In your project directory
railway init
railway up
```

Railway will give you a URL like: `wss://your-app.up.railway.app`

### 2. Deploy Frontend (Vercel) - 3 minutes

```bash
# Install Vercel CLI
npm i -g vercel

# Login
vercel login

# Deploy
vercel --prod

# Set WebSocket URL (replace with your Railway URL)
vercel env add VITE_WS_URL production
# Paste: wss://your-app.up.railway.app
```

**Done!** Your app is live. 🎉

## Alternative: Render (All-in-One)

If you prefer one platform:

1. **Deploy Server on Render:**
   - Go to [render.com](https://render.com)
   - New → Web Service
   - Connect GitHub repo
   - Render will auto-detect `render.yaml`
   - Get URL: `wss://your-app.onrender.com`

2. **Deploy Frontend on Vercel:**
   - Same as above
   - Set `VITE_WS_URL=wss://your-app.onrender.com`

## Environment Variables Checklist

### Vercel (Frontend)
- ✅ `VITE_WS_URL` = `wss://your-server-url.com`

### Railway/Render (Server)
- ✅ `HOST` = `0.0.0.0` (auto-set)
- ✅ `PORT` = auto-set by platform
- ✅ `MODE` = `quick` (or your preference)

## Troubleshooting

**Frontend can't connect?**
- Check `VITE_WS_URL` uses `wss://` (not `ws://`)
- Verify server is running
- Check browser console for errors

**Server not starting?**
- Check Railway/Render logs
- Verify `requirements.txt` is present
- Ensure Python 3.9+ is available

For detailed instructions, see [DEPLOYMENT.md](./DEPLOYMENT.md)

