import { useEffect, useRef, useState } from "react";
import { uploadFile } from "../api/upload";

export default function MessageInput({ onSend, onTyping, onSendAttachment }) {
  const [text, setText] = useState("");
  const [uploading, setUploading] = useState(false);

  const fileRef = useRef(null);
  const typingRef = useRef(false);
  const timerRef = useRef(null);

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

  async function handlePickFile(e) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;

    try {
      setUploading(true);
      const info = await uploadFile(file);
      console.log("UPLOAD OK -> sending attachment", info);
      onSendAttachment?.(info); // ✅
    } catch (err) {
      alert(err.message || "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  function submit(e) {
    e.preventDefault();
    const body = text.trim();
    if (!body) return;

    onSend?.(body);
    setText("");

    if (timerRef.current) clearTimeout(timerRef.current);
    setTyping(false);
  }

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      setTyping(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
