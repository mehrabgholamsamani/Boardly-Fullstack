# Whiteboard (Client + WebSocket Server)

This repo is a **monorepo**:

- `client/` — Vite + React whiteboard UI
- `server/` — Node.js WebSocket server (rooms, presence, cursor ghosts, undo-your-strokes, snapshot re-sync)

## Local dev

```bash
npm install
npm run dev:all
```

- Client: http://localhost:5173 (or whatever Vite prints)
- WS Server: ws://localhost:8787

## Deploy

### 1) Deploy the WebSocket server to Render

Create a **Web Service** on Render from this repo, and set:

- **Root Directory:** `server`
- **Build Command:** `npm install && npm run build`
- **Start Command:** `npm run start`

Render sets `PORT` automatically (the server uses `process.env.PORT`).

After deploy, your WS url is:

- `wss://YOUR-RENDER-SERVICE.onrender.com`

### 2) Deploy the client to Vercel

Create / import a Vercel project from the same repo and set:

- **Root Directory:** `client`
- **Environment Variable:** `VITE_WS_URL = wss://YOUR-RENDER-SERVICE.onrender.com`

Then redeploy.

## Notes

- In production, **use `wss://`** (https site + ws:// will be blocked by browsers).
- The board state is stored in-memory per server instance (good for demos/portfolio).
