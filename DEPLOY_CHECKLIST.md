# Deploy + Reliability Checklist

## Pre-Deploy Verification

1. Run `npm ci` at repo root.
2. Run `npm run verify` at repo root.
3. Confirm `WS simulation test passed.` appears in output.

## Vercel (Client)

1. Project root directory: `client`
2. Build command: `npm run build`
3. Output directory: `dist`
4. Required env vars:
   - `VITE_WS_URL` (must point to Render WS URL, supports `https://` or `wss://`)
5. Optional env vars:
   - `VITE_DEBUG=0` in production (`1` only for short-term debugging)
6. After changing any `VITE_*` env var, trigger a new deployment. Existing deployments keep old values.

## Render (Server)

1. Service root directory: `server`
2. Build command: `npm ci && npm run build`
3. Start command: `npm run start`
4. Bind port: use Render-provided `PORT` (already handled in code)
5. Recommended env vars:
   - `ALLOWED_ORIGINS=https://<your-vercel-domain>.vercel.app`
   - Add multiple origins with comma separation
6. Confirm logs show `[ws] listening host=0.0.0.0 port=<port> env=<env>`.
7. Public WebSocket URL format is `wss://<render-service>.onrender.com` (no explicit `:PORT` externally).
8. Health check endpoint: `GET /health`.

## Cache / Dependency Recovery

1. If Render install fails or lockfile URLs are wrong, clear Render build cache and redeploy.
2. Keep registry pinned to npmjs:
   - root `.npmrc`
   - `client/.npmrc`
   - `server/.npmrc`
3. Regenerate lockfile only with npmjs registry configured.

## Operational Footguns + Guardrails

1. OneDrive can lock files during install/build; if installs fail intermittently, pause OneDrive sync and rerun.
2. Never commit lockfiles resolved from private/internal registries.
3. Avoid manual WS URL construction in UI code; only use `getWsUrl()` in `client/src/lib/ws.ts`.
4. Env mistakes are silent at runtime unless verified:
   - missing `VITE_WS_URL` in production client now hard-fails WS connection by design.
5. Presence/cursor drift checks:
   - run `npm run verify:ws` after WS protocol changes.
