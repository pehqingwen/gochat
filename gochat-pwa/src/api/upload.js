import { getToken } from "./auth";

export async function uploadFile(file) {
  const fd = new FormData();
  fd.append("file", file);

  const res = await fetch("http://localhost:8080/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${getToken()}`,
      // DO NOT set Content-Type when using FormData
    },
    body: fd,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data; // { url, mime, size, filename }
}
