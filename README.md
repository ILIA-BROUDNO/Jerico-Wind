# Deploying this Worker (free Cloudflare account)

Everything below uses the Cloudflare dashboard — no CLI required.

## 1. Create the D1 database
1. Dashboard → **Workers & Pages** → **D1** → **Create database**. Name it anything.
2. Open it → **Console** → paste the contents of `schema.sql` → run it.
3. On the database's **Overview** page, copy the **Database ID** (a UUID) — you'll need it below.

## 2. Create the Worker
1. **Workers & Pages** → **Create** → **Worker**. Give it a name (e.g. `jerico-wind`).
2. Open the code editor → replace all content with `worker.js`.
3. In the code, find `const WORKER_SCRIPT_NAME = '...'` near the top and set it to the **exact name** you gave the Worker in step 2 (must match — the usage-stats card depends on this).

## 3. Bind the D1 database
1. Worker → **Settings** → **Bindings** → **Add** → **D1 Database**.
2. Variable name: `DB` (must be exactly this — the code expects it).
3. Select the database created in step 1.

## 4. Add variables/secrets
Worker → **Settings** → **Variables and Secrets** → **Add**, one at a time:

| Name | Value | Encrypt? |
|---|---|---|
| `CF_API_TOKEN` | API token with **Account Analytics: Read** permission (create at My Profile → API Tokens → Create Token) | Yes |
| `ACCOUNT_ID` | Your Cloudflare account ID (dashboard sidebar, or in the dashboard URL) | No |
| `D1_DATABASE_ID` | The Database ID from step 1 | No |

## 5. Set the cron trigger
1. Worker → **Settings** → **Triggers** → **Cron Triggers** → **Add**.
2. Schedule: `*/1 * * * *` (every minute).

## 6. Deploy
Click **Save and Deploy** in the code editor. Your site is live at:
```
https://<worker-name>.<your-subdomain>.workers.dev
```

## Files in this repo
- `worker.js` — the entire app: HTML frontend, API routes, and the cron job that polls the weather/tide sources and writes to D1.
- `schema.sql` — D1 table definitions. Run once, in step 1.
