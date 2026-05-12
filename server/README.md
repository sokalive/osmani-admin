# Osmani Admin — API (Express)

Channels and admin routes are under **`/api/*`**. Stream proxy is mounted at the app root (not under `/api`).

## Run locally

```bash
cd server
npm install
npm start
```

Default URL: **http://localhost:4000** (override with `PORT`).

## Render deploy (required)

The repo root is the **frontend** (Vite). This API must run with **Root Directory = `server`**.

| Render setting | Value |
|----------------|--------|
| Root Directory | `server` |
| Build Command | `npm install` |
| Start Command | `npm start` |

Wrong root → wrong `package.json` → routes like `/stream-proxy-test` will 404.

## Useful paths

| Path | Description |
|------|-------------|
| `GET /api/health` | API health |
| `GET /api/channels` | Channel list (requires `DATABASE_URL`; includes raw URLs plus proxy-ready playback fields) |
| `GET /stream-proxy` | IPTV/HLS proxy + manifest rewrite |
| `GET /stream-proxy-test` | Same as above (public smoke test; e.g. Mux sample m3u8) |

## Frontend dev

From repo root `.env`:

```env
VITE_API_BASE_URL=http://localhost:4000
```

Then `npm run dev` from repo root.
