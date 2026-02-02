import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { http } from "../api/http";

function formatTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch {
    return "";
  }
}

export default function Starred() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setLoading(true);
      setErr("");
      try {
        const data = await http(`/starred?limit=100`);
        console.log("starred raw first row:", data?.[0]);
        setRows(Array.isArray(data) ? data : []);

      } catch (e) {
        console.warn("load starred failed", e);
        setErr(e?.message || "Failed to load starred messages");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const grouped = useMemo(() => {
    const m = new Map();
    for (const it of rows) {
      const key = `${it.roomId}::${it.roomName || ""}`;
      if (!m.has(key)) m.set(key, { roomId: it.roomId, roomName: it.roomName || "", items: [] });
      m.get(key).items.push(it);
    }
    // keep newest first inside each group (server already sends newest-first usually)
    return Array.from(m.values());
  }, [rows]);

  return (
    <div style={{ maxWidth: 820, margin: "40px auto", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Saved</div>
          <h2 style={{ margin: 0 }}>⭐ Starred messages</h2>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
            {rows.length} message(s)
          </div>
        </div>
        <Link to="/rooms" style={{ textDecoration: "none" }}>← Back</Link>
      </div>

      <div style={{ marginTop: 14 }}>
        {loading ? (
          <div style={{ opacity: 0.7 }}>Loading…</div>
        ) : err ? (
          <div style={{ color: "crimson" }}>{err}</div>
        ) : rows.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No starred messages yet.</div>
        ) : (
          grouped.map((g) => (
            <div key={`${g.roomId}::${g.roomName}`} style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ fontWeight: 700 }}>
                  {g.roomName ? `${g.roomName}` : `Room ${g.roomId}`}
                  <span style={{ fontSize: 12, opacity: 0.7, marginLeft: 8 }}>
                    ({g.items.length})
                  </span>
                </div>
                <Link to={`/rooms/${g.roomId}`} style={{ textDecoration: "none", fontSize: 13 }}>
                  Open room →
                </Link>
              </div>

              <div style={{ marginTop: 10, display: "grid", gap: 10 }}>
                {g.items.map((m) => {
                  const isDeleted = !!m.deleted;
                  const hasAttachment = !!m.attachment;
                  const attachmentLabel = hasAttachment
                    ? m.attachment.filename || "attachment"
                    : "";

                  return (
                    <div
                      key={`star_${m.id}`}
                      style={{
                        border: "1px solid #eee",
                        borderRadius: 14,
                        padding: 12,
                        background: "white",
                      }}
                    >
                      <div style={{ fontSize: 12, opacity: 0.75 }}>
                        <span style={{ fontWeight: 600 }}>{m.userEmail}</span>
                        {" • "}
                        {formatTime(m.createdAt)}
                        {m.edited ? " • (edited)" : ""}
                      </div>

                      {isDeleted ? (
                        <div style={{ marginTop: 6, fontSize: 13, opacity: 0.6, fontStyle: "italic" }}>
                          Message deleted
                        </div>
                      ) : (
                        <>
                          {m.body ? (
                            <div style={{ marginTop: 6, fontSize: 15, whiteSpace: "pre-wrap" }}>
                              {m.body}
                            </div>
                          ) : null}

                          {hasAttachment ? (
                            <div style={{ marginTop: 8 }}>
                              {m.attachment.mime?.startsWith("image/") ? (
                                <img
                                  src={`${(import.meta.env.VITE_API_BASE || "http://localhost:8080")}${m.attachment.url}`}
                                  alt={m.attachment.filename || "image"}
                                  style={{
                                    maxWidth: "100%",
                                    borderRadius: 12,
                                    border: "1px solid #eee",
                                    display: "block",
                                  }}
                                />
                              ) : m.attachment.mime?.startsWith("video/") ? (
                                <video
                                  src={`${(import.meta.env.VITE_API_BASE || "http://localhost:8080")}${m.attachment.url}`}
                                  controls
                                  style={{ maxWidth: "100%", borderRadius: 12, border: "1px solid #eee" }}
                                />
                              ) : m.attachment.mime?.startsWith("audio/") ? (
                                <audio
                                  src={`${(import.meta.env.VITE_API_BASE || "http://localhost:8080")}${m.attachment.url}`}
                                  controls
                                  style={{ width: "100%" }}
                                />
                              ) : (
                                <div style={{ marginTop: 6 }}>
                                  <a
                                    href={`${(import.meta.env.VITE_API_BASE || "http://localhost:8080")}${m.attachment.url}`}
                                    target="_blank"
                                    rel="noreferrer"
                                    style={{ textDecoration: "underline" }}
                                  >
                                    Download {attachmentLabel}
                                  </a>
                                </div>
                              )}
                            </div>
                          ) : null}
                        </>
                      )}

                      <div style={{ marginTop: 10 }}>
                        <Link to={`/rooms/${g.roomId}`} style={{ textDecoration: "none", fontSize: 13 }}>
                          Jump to room →
                        </Link>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
