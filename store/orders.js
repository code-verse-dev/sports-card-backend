/** In-memory order store. Replace with DB in production. */
const orders = [];
let nextId = 1;

export const ORDER_STATUSES = [
  "pending",
  "pending_payment",
  "payment_failed",
  "confirmed",
  "in_production",
  "shipped",
  "delivered",
  "cancelled",
];

export function getAllOrders(filters = {}) {
  let list = [...orders].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (filters.status) {
    list = list.filter((o) => o.status === filters.status);
  }
  if (filters.email) {
    const q = String(filters.email).toLowerCase();
    list = list.filter((o) => (o.customer?.email || "").toLowerCase().includes(q));
  }
  return list;
}

/** Paginated slice for admin list (same filters as getAllOrders). */
export function getOrdersPage(filters = {}) {
  const page = Math.max(1, parseInt(String(filters.page ?? 1), 10) || 1);
  const limitRaw = parseInt(String(filters.limit ?? 10), 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10));
  const list = getAllOrders({
    status: filters.status,
    email: filters.email,
  });
  const total = list.length;
  const start = (page - 1) * limit;
  const slice = list.slice(start, start + limit);
  const totalPages = Math.max(1, Math.ceil(total / limit));
  return { orders: slice, total, page, limit, totalPages };
}

export function getOrderById(id) {
  return orders.find((o) => o.id === id);
}

export function createOrder(data) {
  const id = String(nextId++);
  const order = {
    id,
    status: "pending",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...data,
  };
  orders.push(order);
  return order;
}

export function updateOrderStatus(id, status) {
  const order = orders.find((o) => o.id === id);
  if (!order) return null;
  if (!ORDER_STATUSES.includes(status)) return null;
  order.status = status;
  order.updatedAt = new Date().toISOString();
  return order;
}

export function updateOrder(id, updates) {
  const order = orders.find((o) => o.id === id);
  if (!order) return null;
  if (updates.status != null && !ORDER_STATUSES.includes(updates.status)) return null;
  Object.assign(order, updates, { updatedAt: new Date().toISOString() });
  return order;
}

/** Remove order from in-memory store. Returns true if an order was removed. */
export function deleteOrderById(id) {
  const idx = orders.findIndex((o) => o.id === id);
  if (idx === -1) return false;
  orders.splice(idx, 1);
  return true;
}

/** Remove every order from the in-memory store. Returns how many were removed. */
export function deleteAllOrders() {
  const n = orders.length;
  orders.length = 0;
  return n;
}
