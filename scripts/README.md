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
