# Server scripts

**Include this folder when you deploy the API to live** so you can run migrations on the server.

## One-time migration: URL-style category/subcategory ids

- **Script:** `migrate-categories-to-url-ids.js`
- **When:** Once per environment (local already done; run once on live if the DB has old ids).
- **From server directory:**
  ```bash
  cd /path/to/api.customsportscards.live/server
  node scripts/migrate-categories-to-url-ids.js
  ```
- **From project root:**
  ```bash
  node server/scripts/migrate-categories-to-url-ids.js
  ```
- **Requires:** `MONGODB_URI` in the environment (e.g. in `server/.env` on the server).

If this folder was not copied to live, copy at least `server/scripts/migrate-categories-to-url-ids.js` (and ensure `server/seed-categories.js`, `server/db.js`, and `server/models/` are present so the script can run), or run the script locally with `MONGODB_URI` set to your live database URL.

## One-time backfill: template slugs for product URLs

- **Script:** `backfill-template-slugs.js`
- **When:** Run once on live so product URLs use slugs (e.g. `/product/swimming-trading-card-01/preview`) instead of UUIDs (`/product/569c3720-b5ee-4379-bdb1-82ee93f30106/preview`).
- **What it does:** Sets each template’s `id` and `templateId` to a URL-safe slug derived from the template name (e.g. "Swimming Trading Card 01" → `swimming-trading-card-01`). Templates that already have a slug are skipped. Old UUIDs are stored in `legacyIds` so existing UUID links still work.
- **From server directory:**
  ```bash
  cd /path/to/api.customsportscards.live/server
  node scripts/backfill-template-slugs.js
  ```
- **From project root:**
  ```bash
  node server/scripts/backfill-template-slugs.js
  ```
- **Requires:** `MONGODB_URI` in the environment (e.g. in `server/.env`).
