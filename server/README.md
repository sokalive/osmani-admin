# Osmani Admin — Channels API

Express CRUD backed by **`server/data/channels.json`** (no database).

## Run (exact steps)

```bash
cd server
npm install
node src/index.js
```

Default URL: **http://localhost:4000** (override with `PORT` env).

## Frontend

In the project root `.env`:

```env
VITE_API_BASE_URL=http://localhost:4000
```

Then start Vite (`npm run dev` from repo root).

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/channels` | List channels (sorted by id) |
| POST | `/channels` | Create (`name` + `url` required) |
| PUT | `/channels/:id` | Update |
| DELETE | `/channels/:id` | Delete (204) |

`GET /health` → `{ ok: true }`.

If `data/channels.json` is missing, it is created as `[]` on startup.
