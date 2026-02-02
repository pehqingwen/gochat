export function connectWS() {
  const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";
  const token = localStorage.getItem("gochat_token") || "";

  const wsBase = API_BASE.replace(/^http/, "ws");
  const url = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

  return new WebSocket(url);
}
