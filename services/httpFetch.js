import nodeFetch from "node-fetch";

/**
 * Global `fetch` exists in Node 18+. Some production hosts still run Node 16.
 */
export const httpFetch =
  typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : /** @type {typeof fetch} */ (nodeFetch);
