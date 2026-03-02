# QA + Reliability Validation Plan

## Scope

- Environment parity (`localhost` vs deployed Vercel/Render)
- WebSocket URL/env config correctness
- Message schema safety (invalid payloads ignored)
- Room isolation and snapshot correctness
- Presence/cursor consistency
- Undo ownership protections
- Reconnect race behavior
- Room cleanup / memory leak signals

## Automated Gate (Required on every merge)

1. `npm run verify`
2. Pass criteria:
   - TypeScript project build passes for `client` and `server`
   - Production builds pass for both apps
   - WS simulation test passes (multi-client)

## WS Simulation Assertions (`tools/ws-sim-test.mjs`)

1. Same-room broadcast:
   - `element:add` from client A is received by room peers.
2. Cross-room isolation:
   - clients in other rooms do not receive room events.
3. Late-join snapshot:
   - new joiner snapshot includes previously committed elements.
4. Undo/ownership safety:
   - non-owner `element:remove` is ignored.
   - owner `element:remove` succeeds and broadcasts.
5. Presence drift:
   - presence counts update on join, leave, and reconnect.
6. Reconnect race:
   - disconnected/reconnected client receives current snapshot.
7. Room cleanup:
   - when all users leave, subsequent join starts from empty state.
8. Sender identity normalization:
   - cursor `clientId` is rewritten to authenticated socket `clientId`.

## Manual Spot Checks (Pre-release)

1. Open two browser tabs on same room:
   - draw stroke, shape, delete, clear, undo/redo.
2. Open one tab in a different room:
   - verify no leaked updates.
3. Restart Render service while clients are open:
   - verify reconnect and fresh snapshot recovery.
4. Toggle `VITE_DEBUG=1` in Vercel preview:
   - confirm WS lifecycle logs appear.
5. Return `VITE_DEBUG=0` for production deploy.

## Production Readiness Checks

1. Follow `DEPLOY_CHECKLIST.md` exactly.
2. Verify env variables are present before deploy:
   - Vercel: `VITE_WS_URL`
   - Render: `ALLOWED_ORIGINS` (or `CORS_ORIGINS`)
3. After env edits, force rebuild/redeploy both services.
