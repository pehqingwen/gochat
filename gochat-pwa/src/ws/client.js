import { getToken } from "../api/auth";

export function connectWS() {
  const token = getToken();
  const base = import.meta.env.VITE_WS_BASE || "ws://localhost:8080";
  const ws = new WebSocket(`${base}/ws?token=${encodeURIComponent(token)}`);
  return ws;
}
