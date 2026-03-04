/** In-memory order store. Replace with DB in production. */
const orders = [];
let nextId = 1;

export const ORDER_STATUSES = [
  "pending",
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
