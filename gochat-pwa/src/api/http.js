import { getToken } from "./auth";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";

export async function http(path, opts = {}) {
  const token = getToken();

  const res = await fetch(`${API_BASE}${path}`, {
    method: opts.method || "GET",
    headers: {
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
    body: opts.body || undefined,
  });

  if (res.status === 204) return null;

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }

  if (!res.ok) {
    throw new Error(data?.error || res.statusText || `HTTP ${res.status}`);
  }
  return data;
}
