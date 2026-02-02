import { useEffect, useRef, useState } from "react";
import { uploadFile } from "../api/upload";
import { http } from "../api/http";

export default function MessageInput({ roomIDNum, onSend, onTyping, editingPoll, onCloseEditPoll, onEditPoll, m, myEmail }) {
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingPreviewUrl, setPendingPreviewUrl] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");

  const fileRef = useRef(null);
  const typingRef = useRef(false);
  const timerRef = useRef(null);

  const [pollOpen, setPollOpen] = useState(false);
  const [pollQ, setPollQ] = useState("");
  const [pollOpts, setPollOpts] = useState(["", ""]);
  const [pollEditId, setPollEditId] = useState(null); // messageId when editing

  useEffect(() => {
    if (!editingPoll) return;
    setPollEditId(editingPoll.messageId);
    setPollQ(editingPoll.question || "");
    setPollOpts(editingPoll.options?.length ? editingPoll.options : ["", ""]);
    setPollOpen(true);
  }, [editingPoll]);

  async function createPoll() {
    const question = pollQ.trim();
    const options = pollOpts.map(s => s.trim()).filter(Boolean);

    if (!question) return alert("Poll question required");
    if (options.length < 2) return alert("Need at least 2 options");

    // roomIDNum should already exist in this component; if not, pass it in as prop
    await http(`/rooms/${roomIDNum}/polls`, {
      method: "POST",
      body: JSON.stringify({ question, options }),
    });

    setPollOpen(false);
    resetPollForm();
  }

  function resetPollForm() {
    setPollEditId(null);
    setPollQ("");
    setPollOpts(["", ""]);
  }

  function closePollModal() {
    setPollOpen(false);
    resetPollForm();
    onCloseEditPoll?.(); // clears editingPoll in Room.jsx
  }

  async function submitPoll() {
    const question = pollQ.trim();
    const options = pollOpts.map(s => s.trim()).filter(Boolean);

    if (!question) return alert("Poll question required");
    if (options.length < 2) return alert("Need at least 2 options");

    if (pollEditId) {
      // EDIT
      await http(`/polls/${pollEditId}`, {
        method: "PUT",
        body: JSON.stringify({ question, options }),
      });
    } else {
      // CREATE
      await http(`/rooms/${roomIDNum}/polls`, {
        method: "POST",
        body: JSON.stringify({ question, options }),
      });
    }

    closePollModal();
  }

  function onPickFile(e) {
    const f = e.target.files?.[0];
    if (!f) return;

    setPendingFile(f);

    // preview only for images/video/audio (optional)
    if (f.type.startsWith("image/") || f.type.startsWith("video/") || f.type.startsWith("audio/")) {
      const url = URL.createObjectURL(f);
      setPendingPreviewUrl(url);
    } else {
      setPendingPreviewUrl("");
    }

    // important: allow selecting same file again later
    e.target.value = "";
  }

  function clearPending() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl("");
    setPendingFile(null);
  }

  async function handleSend() {
    const bodyTrim = text.trim();

    // nothing to send
    if (!bodyTrim && !pendingFile) return;

    // if attachment staged: upload now
    let attachment = null;
    if (pendingFile) {
      attachment = await uploadFile(pendingFile); // returns { url, mime, filename, size }
    }

    // call parent to send ws message
    onSend?.(bodyTrim, attachment);

    setText("");
    clearPending();
  }

  function setTyping(next) {
    if (typingRef.current === next) return;
    typingRef.current = next;
    onTyping?.(next);
  }

  function handleChange(e) {
    const v = e.target.value;
    setText(v);

    if (v.trim().length > 0) setTyping(true);

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setTyping(false), 1200);
  }

  function handlePickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    // If you had an old preview, revoke it
    if (previewUrl) URL.revokeObjectURL(previewUrl);

    setPendingFile(file);

    // preview for media
    if (file.type.startsWith("image/") || file.type.startsWith("video/") || file.type.startsWith("audio/")) {
      setPreviewUrl(URL.createObjectURL(file));
    } else {
      setPreviewUrl("");
    }
  }

  async function submit(e) {
    e.preventDefault();

    const body = text.trim();

    // nothing to send
    if (!body && !pendingFile) return;

    try {
      let attachment = null;

      if (pendingFile) {
        setUploading(true);
        attachment = await uploadFile(pendingFile); // ✅ upload happens only on Send
      }

      onSend?.(body, attachment); // ✅ change onSend signature
      setText("");
      clearPending();

      if (timerRef.current) clearTimeout(timerRef.current);
      setTyping(false);
    } catch (err) {
      alert(err?.message || "Send failed");
    } finally {
      setUploading(false);
    }
  }

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") {
        setPollOpen(false);
        resetPollForm();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);


  return (
    <form onSubmit={submit} style={{ display: "flex", gap: 8, marginTop: 12 }}>
      {/* Hidden file input */}
      <input
        ref={fileRef}
        type="file"
        onChange={handlePickFile}
        style={{ display: "none" }}
      />

      {pendingFile ? (
        <div style={{ border: "1px solid #eee", borderRadius: 12, padding: 10, marginBottom: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                📎 {pendingFile.name}
              </div>
              <div style={{ fontSize: 12, opacity: 0.7 }}>
                {(pendingFile.size / 1024).toFixed(1)} KB • {pendingFile.type || "unknown"}
              </div>
            </div>

            <button type="button" onClick={clearPending} style={{ border: "1px solid #ddd", borderRadius: 10, padding: "6px 10px" }}>
              Remove
            </button>
          </div>

          {pendingPreviewUrl && pendingFile.type.startsWith("image/") ? (
            <img src={pendingPreviewUrl} style={{ marginTop: 8, maxWidth: "100%", borderRadius: 12, border: "1px solid #eee" }} />
          ) : null}

          {pendingPreviewUrl && pendingFile.type.startsWith("video/") ? (
            <video src={pendingPreviewUrl} controls style={{ marginTop: 8, maxWidth: "100%", borderRadius: 12, border: "1px solid #eee" }} />
          ) : null}

          {pendingPreviewUrl && pendingFile.type.startsWith("audio/") ? (
            <audio src={pendingPreviewUrl} controls style={{ marginTop: 8, width: "100%" }} />
          ) : null}
        </div>
      ) : null}


      {/* poll UI */}
      {pollOpen ? (
        <div style={{
          position: "fixed", inset: 0, background: "rgba(0,0,0,0.35)",
          display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999
        }}>
          <div style={{ width: 520, background: "white", borderRadius: 16, padding: 16 }}>
            <div style={{ fontWeight: 800, fontSize: 16 }}>
              {pollEditId ? "Edit poll" : "Create poll"}
            </div>

            <input
              value={pollQ}
              onChange={(e) => setPollQ(e.target.value)}
              placeholder="Question"
              style={{ marginTop: 10, width: "100%", padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd" }}
            />

            <div style={{ marginTop: 10, display: "grid", gap: 8 }}>
              {pollOpts.map((v, i) => (
                <div key={i} style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <input
                    value={v}
                    onChange={(e) => {
                      const next = [...pollOpts];
                      next[i] = e.target.value;
                      setPollOpts(next);
                    }}
                    placeholder={`Option ${i + 1}`}
                    style={{ flex: 1, padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd" }}
                  />

                  <button
                    type="button"
                    disabled={pollOpts.length <= 2}
                    title={pollOpts.length <= 2 ? "Need at least 2 options" : "Remove option"}
                    onClick={() => {
                      if (pollOpts.length <= 2) return;
                      setPollOpts((prev) => prev.filter((_, idx) => idx !== i));
                    }}
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      background: "white",
                      cursor: pollOpts.length <= 2 ? "not-allowed" : "pointer",
                      opacity: pollOpts.length <= 2 ? 0.5 : 1,
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={() => pollOpts.length < 6 && setPollOpts([...pollOpts, ""])}
                style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
              >
                + Add option
              </button>

              <div style={{ flex: 1 }} />

              <button
                type="button"
                onClick={closePollModal}
                style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
              >
                Cancel
              </button>

              <button
                type="button"
                onClick={submitPoll}
                style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer", fontWeight: 700 }}
              >
                {pollEditId ? "Save" : "Create"}
              </button>
            </div>
          </div>
        </div>
      ) : null}


      {onEditPoll && myEmail && m.userEmail === myEmail ? (
        <button
          type="button"
          onClick={() => onEditPoll(m)}
          style={{
            marginTop: 10,
            padding: "6px 10px",
            borderRadius: 10,
            border: "1px solid #ddd",
            background: "white",
            cursor: "pointer",
            fontSize: 13,
          }}
        >
          Edit
        </button>
      ) : null}


      {/* Attach button */}
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={uploading}
        style={{
          padding: "12px 12px",
          borderRadius: 12,
          border: "1px solid #ddd",
          cursor: uploading ? "not-allowed" : "pointer",
          opacity: uploading ? 0.6 : 1,
        }}
        title="Attach file"
      >
        {uploading ? "Uploading…" : "Attach"}
      </button>


      {/* Poll */}
      <button
        type="button"
        onClick={() => setPollOpen(true)}
        style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
      >
        Poll
      </button>


      <input
        value={text}
        onChange={handleChange}
        placeholder="Type a message…"
        style={{ flex: 1, padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd" }}
      />

      <button
        type="submit"
        style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
      >
        Send
      </button>
    </form>

  );
}
