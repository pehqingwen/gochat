export default function MessageList({ messages }) {
  const API_BASE = "http://localhost:8080"; // change later when deployed

  return (
    <div
      style={{
        padding: 12,
        height: "65vh",
        overflowY: "auto",
        border: "1px solid #eee",
        borderRadius: 12,
      }}
    >
      {messages.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No messages yet.</div>
      ) : (
        messages.map((m) => (
          <div key={m.id} style={{ marginBottom: 12 }}>
            <div style={{ fontSize: 12, opacity: 0.7 }}>
              {m.userEmail} • {new Date(m.createdAt).toLocaleString()}
            </div>

            {m.body ? <div style={{ fontSize: 16 }}>{m.body}</div> : null}

            {/* ✅ Attachment render */}
            {m.attachment ? (
              <div style={{ marginTop: 8 }}>
                {m.attachment.mime?.startsWith("image/") ? (
                  <img
                    src={`${API_BASE}${m.attachment.url}`}
                    alt={m.attachment.filename || "image"}
                    style={{
                      maxWidth: "100%",
                      borderRadius: 12,
                      border: "1px solid #eee",
                      display: "block",
                    }}
                  />
                ) : (
                  <a
                    href={`${API_BASE}${m.attachment.url}`}
                    target="_blank"
                    rel="noreferrer"
                    style={{ textDecoration: "underline" }}
                  >
                    Download {m.attachment.filename || "file"}{" "}
                    {m.attachment.size ? `(${Math.round(m.attachment.size / 1024)} KB)` : ""}
                  </a>
                )}
              </div>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}
