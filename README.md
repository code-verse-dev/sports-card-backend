# Order & checkout server

Runs the orders API, price config, admin auth, and Stripe Checkout.

## Setup

```bash
cd server
npm install
cp .env.example .env
# Edit .env: MONGODB_URI, JWT_SECRET, STRIPE_SECRET_KEY (use sk_test_... for testing)
```

## Run

```bash
npm start
```

Runs on port **5001** by default (or set `PORT` in `.env`).

## Environment (.env)

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 5001) |
| `MONGODB_URI` | MongoDB connection string. If set, orders and prices use DB; admin auth and protected routes apply. |
| `JWT_SECRET` | Secret for admin JWT (min 32 chars). Required when using DB. |
| `STRIPE_SECRET_KEY` | Stripe secret key (e.g. `sk_test_...` for test mode). Required for checkout when DB is used. |

**First-time with DB:** Seed the default admin with `POST /api/admin/seed-admin` (creates admin@admin.com / admin123).

## Frontend

In the project root, create `.env.local`:

```
VITE_API_URL=http://localhost:5001
```

Restart the Vite dev server. Checkout and admin (Orders, Prices) use this URL. Stripe test card: **4242 4242 4242 4242**.

## Endpoints

- **GET** `/api/prices` – Public price config (quantity tiers, size options, PDF, shipping).
- **POST** `/api/orders/create-checkout-session` – Create Stripe Checkout session. Body: `{ customer, items, shippingCents?, successUrl?, cancelUrl? }`. Returns `{ url, sessionId, orderId }`.
- **POST** `/api/orders/confirm-session` – Confirm payment after redirect. Body: `{ sessionId }`.
- **POST** `/api/orders` – Legacy create order (only when DB is not connected).
- **POST** `/api/admin/login` – Admin login. Body: `{ email, password }`. Returns `{ token, user }`.
- **POST** `/api/admin/seed-admin` – One-time seed default admin (when DB connected).
- **GET** `/api/admin/orders` – List orders (requires auth when DB connected).
- **GET** `/api/admin/orders/:id` – Get one order.
- **PATCH** `/api/admin/orders/:id` – Update order (e.g. `{ status }`).
- **GET** `/api/admin/order-statuses` – List statuses.
- **GET** `/api/admin/prices` – Get price config (requires auth when DB connected).
- **PUT** `/api/admin/prices` – Update price config.

## Order statuses

`pending_payment` (after Stripe session created) → `confirmed` (after payment) → `in_production` → `shipped` → `delivered`, or `cancelled`.

## Data

- **With MongoDB:** Orders and price config are stored in the database. Admin routes require JWT.
- **Without MongoDB:** Orders and prices are in memory (no auth on admin routes).
