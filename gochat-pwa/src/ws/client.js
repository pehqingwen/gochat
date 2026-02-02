import { getToken } from "../api/auth";

const WS_BASE = import.meta.env.VITE_WS_BASE || "ws://localhost:8080";

export function connectWS() {
  const token = getToken();
  return new WebSocket(`${WS_BASE}/ws?token=${encodeURIComponent(token)}`);
}
