# Sports Card Backend

Simple Node server for template CRUD. Templates are stored in MongoDB; images stay in the Next.js `public/` folder.

## Setup

```bash
cd server
cp .env.example .env
# Edit .env: set MONGODB_URI (e.g. mongodb://localhost:27017)
npm install
```

## Run

```bash
npm run dev   # with --watch
# or
npm start
```

Runs on port 4000 by default (`PORT` in `.env` to override).

## API

- `GET /api/templates` – list all templates
- `GET /api/templates/:templateId` – get one template
- `POST /api/admin/templates` – create (body: templateId, template, name, productDetails?, properties?, categoryId?, subcategoryId?)
- `PUT /api/admin/templates/:templateId` – update
- `DELETE /api/admin/templates/:templateId` – delete

## Frontend

In the Next.js app set `NEXT_PUBLIC_API_URL=http://localhost:4000` in `.env.local` so the app talks to this server.
