import { getToken } from "./auth";

const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";

export async function uploadFile(file) {
  const token = getToken();

  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch(`${API_BASE}/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd,
  });

  if (!res.ok) throw new Error((await res.text()) || "upload failed");
  return await res.json();
}
