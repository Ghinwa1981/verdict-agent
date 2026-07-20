# Deploying Verdict's backend (free, always-on)

This runs the web API and the CAP listener together, in one process, on
Render's free tier.

## 1. Push your latest code to GitHub
Make sure `main.py` and `croo_provider.py` (the updated versions) are pushed.

## 2. Create the service on Render
1. Go to https://render.com and sign up (GitHub login is easiest)
2. **New → Web Service**
3. Connect your `verdict-agent` GitHub repo
4. Root directory: `backend`
5. Build command: `pip install -r requirements.txt`
6. Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
7. Instance type: **Free**

## 3. Add environment variables
In the Render dashboard, under "Environment", add every variable from
`.env.example` with your real values:
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_QUICK`, `STRIPE_PRICE_STANDARD`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PROMAX`
- `GROQ_API_KEY`
- `CROO_API_URL`, `CROO_WS_URL`, `CROO_SDK_KEY`

## 4. Deploy
Render builds and starts the service. Check the logs - you should see:
```
Verdict CAP provider is online, listening for orders...
```
This confirms both the web API and the CAP listener are running in the same process.

## 5. Keep it awake (important - free tier limitation)
Render's free web services spin down after 15 minutes with no HTTP traffic.
If that happens, the CAP WebSocket connection drops too. To prevent this:

1. Go to https://uptimerobot.com (free account)
2. Add a new monitor: **HTTP(s)**, URL = your Render service's `/health` endpoint
   (e.g. `https://your-service.onrender.com/health`)
3. Check interval: every 5 minutes

UptimeRobot's pings keep the free instance awake around the clock, at no cost.

## 6. Update the CROO Agent Store listing
Your agent's `endpoint` field (in `agent.json` / the CROO dashboard) should
point to your real Render URL, not localhost, so CAP and other agents can
reach it.