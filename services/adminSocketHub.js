/**
 * Real-time channel for admin SPA: authenticated admins join room `admins`; server emits {@link ADMIN_NOTIFICATION_EVENT}.
 */
import { Server } from "socket.io";
import { verifyToken } from "../middleware/auth.js";
import { AdminUser } from "../models/AdminUser.js";

export const ADMIN_NOTIFICATION_EVENT = "admin_notification";

/** @type {import('socket.io').Server | null} */
let io = null;

function getSocketCorsConfig() {
  const raw = (process.env.SOCKET_CORS_ORIGINS || "").trim();
  if (!raw) {
    /** Dev-friendly default; set SOCKET_CORS_ORIGINS in production (comma-separated origins). */
    return { origin: true, credentials: true };
  }
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return {
    origin: list.length === 1 ? list[0] : list,
    credentials: true,
  };
}

/**
 * Attach Socket.IO to the HTTP server (call once at startup).
 * @param {import('http').Server} httpServer
 */
export function initAdminSocket(httpServer) {
  if (io) return io;

  io = new Server(httpServer, {
    path: "/socket.io",
    cors: getSocketCorsConfig(),
    /** Prefer WS; polling helps through some proxies. */
    transports: ["websocket", "polling"],
  });

  io.on("connection", (socket) => {
    void (async () => {
      const rawAuth = socket.handshake.auth?.token;
      const rawHeader = socket.handshake.headers?.authorization;
      const token =
        typeof rawAuth === "string" && rawAuth.trim()
          ? rawAuth.trim()
          : typeof rawHeader === "string" && rawHeader.startsWith("Bearer ")
            ? rawHeader.slice(7).trim()
            : null;

      if (!token) {
        socket.disconnect(true);
        return;
      }

      const decoded = verifyToken(token);
      if (!decoded?.userId || decoded.type === "customer") {
        socket.disconnect(true);
        return;
      }

      try {
        const admin = await AdminUser.findById(decoded.userId).select("_id").lean();
        if (!admin) {
          socket.disconnect(true);
          return;
        }
      } catch {
        socket.disconnect(true);
        return;
      }

      socket.join("admins");
      socket.emit("admin_socket_ready", { ok: true });
    })();
  });

  console.log("[admin-socket] Socket.IO mounted at /socket.io");
  return io;
}

/**
 * Push an event to every connected admin dashboard tab.
 * @param {{ kind: string; orderId?: string; orderCode?: string; [key: string]: unknown }} payload
 */
export function emitAdminNotification(payload) {
  if (!io) return;
  io.to("admins").emit(ADMIN_NOTIFICATION_EVENT, {
    ...payload,
    at: new Date().toISOString(),
  });
}
