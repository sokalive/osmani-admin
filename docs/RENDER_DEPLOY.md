# Render deploy — required for VPS/Render commit parity

GitHub Actions **cannot** deploy Render services until these secrets exist:

| GitHub secret | Where to get it |
|---------------|-----------------|
| `RENDER_API_DEPLOY_HOOK` | [Render Dashboard](https://dashboard.render.com) → **osmani-admin-api** → Settings → **Deploy Hook** → copy URL |
| `RENDER_MPYA_DEPLOY_HOOK` | Same → **osmani-admin-mpya** → Settings → **Deploy Hook** |

Add secrets: GitHub repo → Settings → Secrets and variables → Actions → New repository secret.

After adding secrets, either push to `main` (paths under `server/**` or `src/**`) or run:

```bash
gh workflow run "Deploy Render API" --ref main
gh workflow run "Deploy Render Admin (mpya)" --ref main
```

## Option B — Render API key (one-shot from your machine)

1. Create API key: https://dashboard.render.com/u/settings#api-keys  
2. Run:

```powershell
$env:RENDER_API_KEY = "rnd_..."
$env:EXPECT_COMMIT = "b2d7e12"
npm run deploy:render
```

This triggers **osmani-admin-api** and **osmani-admin-mpya** deploys for commit `b2d7e12` and waits until live.

## Option C — Manual dashboard

For each service (**osmani-admin-api**, **osmani-admin-mpya**):

1. Open service in Render Dashboard  
2. **Manual Deploy** → **Deploy latest commit** (or **Deploy a specific commit** → `b2d7e12`)  
3. Wait until status **Live**

## Verify all hosts on same commit

```bash
npm run verify:final-production-pass
```

Expected: VPS API, Render API, and 100-round audit all **PASS**.
