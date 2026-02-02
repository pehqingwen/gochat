import { useEffect, useRef, useState, useLayoutEffect } from "react";
import React from "react";

const MEDIA_W = 320; // preview width
const MEDIA_H = 220; // preview height
const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";

function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const EMAIL_COLORS = [
  "#2563eb", // blue
  "#7c3aed", // violet
  "#db2777", // pink
  "#ea580c", // orange
  "#16a34a", // green
  "#0d9488", // teal
  "#0891b2", // cyan
  "#4f46e5", // indigo
  "#b91c1c", // red
  "#a16207", // amber
  "#15803d", // emerald
  "#9333ea", // purple
];

function colorFromEmail(email) {
  const e = (email || "").trim().toLowerCase();
  if (!e) return "#64748b"; // gray fallback if missing
  const idx = hashString(e) % EMAIL_COLORS.length;
  return EMAIL_COLORS[idx];
}

function useLongPress(onLongPress, ms = 500) {
  const timer = useRef(null);
  const start = () => { timer.current = setTimeout(() => onLongPress?.(), ms); };
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };

  return {
    onPointerDown: start,
    onPointerUp: clear,
    onPointerCancel: clear,
    onPointerMove: clear,
  };
}

function truncateText(s, max = 80) {
  if (!s) return "";
  const str = String(s);
  return str.length > max ? str.slice(0, max - 1) + "…" : str;
}

function MediaBox({ kind, src, title, onOpen }) {
  return (
    <div
      onClick={() => onOpen?.({ kind, src, title })}
      style={{
        width: "min(100%, " + MEDIA_W + "px)",
        height: MEDIA_H,
        borderRadius: 12,
        border: "1px solid #eee",
        overflow: "hidden",
        background: "#fafafa",
        cursor: "pointer",
        position: "relative",
      }}
      title="Click to open"
    >
      {kind === "image" ? (
        <img
          src={src}
          alt={title || "image"}
          style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          loading="lazy"
        />
      ) : kind === "video" ? (
        <>
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
          />
          {/* play badge */}
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none",
            }}
          >
            <div
              style={{
                width: 46,
                height: 46,
                borderRadius: 999,
                background: "rgba(0,0,0,0.45)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "white",
                fontSize: 18,
              }}
            >
              ▶
            </div>
          </div>
        </>
      ) : kind === "audio" ? (
        <div style={{ padding: 12, height: "100%", display: "flex", alignItems: "center" }}>
          <audio src={src} controls style={{ width: "100%" }} />
        </div>
      ) : (
        <div style={{ padding: 12 }}>
          <div style={{ fontWeight: 700, fontSize: 13 }}>📎 File</div>
          <div style={{ fontSize: 13, opacity: 0.8, marginTop: 4, wordBreak: "break-word" }}>
            {title || src}
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            Click to open
          </div>
        </div>
      )}
    </div>
  );
}

function ReactionPopover({ detail, emoji, myEmail }) {
  if (!detail || !emoji) return null;

  const item = (detail.items || []).find((x) => x.emoji === emoji);
  const users = item?.users || [];
  const labels = users.map((u) => (u === myEmail ? "You" : u));

  const max = 8;
  const shown = labels.slice(0, max);
  const more = labels.length - shown.length;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, maxWidth: 320 }}>
      {/* <span style={{ fontSize: 16 }}>{emoji}</span> */}
      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {shown.join(", ")}{more > 0 ? `, +${more} more` : ""}
      </span>
    </div>
  );
}

function MessageItem({ m, API_BASE, onMessageMenu, byDbId, onOpenMedia, onToggleReaction, myUserId, myEmail, onVotePoll, selectMode, selectedIds, onToggleSelectId }) {
  const lp = useLongPress(() => onMessageMenu?.(m), 500);
  const isDeleted = !!m.deleted;
  const replied = m.replyToId ? byDbId.get(m.replyToId) : null;

  const [hover, setHover] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef(null);

  const QUICK = ["👍", "❤️", "😂", "😮", "😢", "😡"];
  const [rxOpen, setRxOpen] = useState(false);
  const [rxDetail, setRxDetail] = useState(null);
  const [rxLoading, setRxLoading] = useState(false);
  const [hoverEmoji, setHoverEmoji] = useState(null);
  const [anchorEl, setAnchorEl] = useState(null);
  const chipsWrapRef = useRef(null);

  const emailColor = colorFromEmail(m.userEmail);
  const canSelect = !!m.dbId && !m.deleted; // ✅ allow selecting others too
  const checked = !!m.dbId && selectedIds?.has(m.dbId);

  function onToggle() {
    if (!canSelect) return;
    onToggleSelectId?.(m.dbId);
  }

  async function loadReactionUsers(force = false) {
    if (!m?.dbId) return;
    if (!force && (rxLoading || rxDetail)) return;

    setRxLoading(true);
    try {
      const data = await http(`/messages/${m.dbId}/reactions`, { cache: "no-store" });
      setRxDetail(data);
    } finally {
      setRxLoading(false);
    }
  }

  useEffect(() => {
    function onDocDown(e) {
      if (!pickerRef.current) return;
      if (!pickerRef.current.contains(e.target)) setPickerOpen(false);
    }
    document.addEventListener("mousedown", onDocDown);
    return () => document.removeEventListener("mousedown", onDocDown);
  }, []);


  async function applyReaction(emoji) {
    await onToggleReaction?.(m, emoji);

    // if popup is showing this message's reactions, refresh list now
    if (hoverEmoji) {
      setRxDetail(null);
      await loadReactionUsers(true); // force refetch
    } else {
      setRxDetail(null);
    }
  }


  // m.reactions expected shape:
  // [{ emoji: "😂", count: 3, me: true }]
  const reactions = Array.isArray(m.reactions) ? m.reactions : [];


  return (
    <div
      {...lp}
      onContextMenu={(e) => { e.preventDefault(); onMessageMenu?.(m); }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setPickerOpen(false); }}
      style={{
        marginBottom: 12,
        padding: isDeleted ? 0 : 10,
        borderRadius: 12,
        border: isDeleted ? "none" : "1px solid #f2f2f2",
        position: "relative",
        background: checked ? "rgba(17,17,17,0.04)" : "white",
      }}
    >

      {/* checkbox for selection */}
      {selectMode ? (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onToggle(); }}
          style={{
            position: "absolute",
            top: 8,
            left: 8,
            width: 26,
            height: 26,
            borderRadius: 999,
            border: checked ? "1px solid #111" : "1px solid #ddd",
            background: checked ? "rgba(17,17,17,0.10)" : "white",
            cursor: canSelect ? "pointer" : "not-allowed",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 999,
          }}
        >
          {checked ? "✓" : ""}
        </button>
      ) : null}


      {!isDeleted ? (
        <>

          {/* ✅ system message bubble */}
          {m.kind === "system" ? (
            <div
              style={{
                textAlign: "center",
                fontSize: 12,
                opacity: 0.75,
                padding: "6px 8px",
              }}
            >
              {m.body}
            </div>
          ) : null}


          {/* Hover 🙂 button */}
          {hover ? (
            <button
              type="button"
              title="React"
              onClick={(e) => { e.stopPropagation(); setPickerOpen((v) => !v); }}
              style={{
                position: "absolute",
                top: -8,
                right: -8,
                width: 28,
                height: 28,
                borderRadius: 999,
                border: "1px solid #e6e6e6",
                background: "white",
                cursor: "pointer",
                boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
              }}
            >
              🙂
            </button>
          ) : null}

          {/* Popup picker */}
          {pickerOpen ? (
            <div
              ref={pickerRef}
              style={{
                position: "absolute",
                top: 24,
                right: 0,
                background: "white",
                border: "1px solid #e6e6e6",
                borderRadius: 12,
                padding: 6,
                display: "flex",
                gap: 6,
                zIndex: 20,
                boxShadow: "0 6px 24px rgba(0,0,0,0.10)",
              }}
            >
              {QUICK.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => applyReaction(emoji)}
                  style={{
                    border: "none",
                    background: "transparent",
                    cursor: "pointer",
                    fontSize: 18,
                    padding: "4px 6px",
                    borderRadius: 10,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#f6f6f6")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  {emoji}
                </button>
              ))}
            </div>
          ) : null}

          <div style={{ fontSize: 12, opacity: 0.85, display: "flex", gap: 6, alignItems: "center" }}>
            <span
              title={m.userEmail}
              style={{
                color: emailColor,
                fontWeight: 700,
                background: "rgba(0,0,0,0.03)",
                padding: "2px 8px",
                borderRadius: 999,
                maxWidth: 260,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {m.userEmail}
            </span>

            <span style={{ opacity: 0.7 }}>
              • {new Date(m.createdAt).toLocaleString()}
              {m.edited ? " • (edited)" : ""}
            </span>

            {m.starred ? <span title="Starred">⭐</span> : null}
          </div>

          {/* reply preview (optional) */}
          {replied ? (
            <div style={{ marginTop: 6, marginBottom: 6, padding: "8px 10px", borderLeft: "3px solid #ddd", background: "#fafafa", borderRadius: 10 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Replying to {replied.userEmail}</div>
              <div
                style={{
                  fontSize: 13,
                  overflow: "hidden",
                  display: "-webkit-box",
                  WebkitLineClamp: 1,
                  WebkitBoxOrient: "vertical",
                  overflowWrap: "anywhere",
                }}
                title={replied.deleted ? "(message deleted)" : (replied.body || replied.attachment?.filename || "(attachment)")}
              >
                {replied.deleted
                  ? "(message deleted)"
                  : truncateText(replied.body || replied.attachment?.filename || "(attachment)", 90)}
              </div>
            </div>
          ) : null}

          {m.body ? <div style={{ fontSize: 16, marginTop: 6 }}>{m.body}</div> : null}

          {m.attachment ? (
            m.attachment.mime?.startsWith("image/") ? (
              <MediaBox
                kind="image"
                src={`${API_BASE}${m.attachment.url}`}
                title={truncateText(m.attachment.filename || "file", 40)}
                onOpen={onOpenMedia}
              />
            ) : m.attachment.mime?.startsWith("video/") ? (
              <MediaBox
                kind="video"
                src={`${API_BASE}${m.attachment.url}`}
                title={truncateText(m.attachment.filename || "file", 40)}
                onOpen={onOpenMedia}
              />
            ) : m.attachment.mime?.startsWith("audio/") ? (
              <MediaBox
                kind="audio"
                src={`${API_BASE}${m.attachment.url}`}
                title={truncateText(m.attachment.filename || "file", 40)}
                onOpen={onOpenMedia}
              />
            ) : (
              <a
                href={`${API_BASE}${m.attachment.url}`}
                target="_blank"
                rel="noreferrer"
                style={{ textDecoration: "underline" }}
              >
                Download {truncateText(m.attachment.filename || "file", 40)}
              </a>
            )
          ) : null}

          {m.kind === "poll" && m.poll ? (
            <div style={{ marginTop: 8, border: "1px solid #eee", borderRadius: 12, padding: 10 }}>
              <div style={{ fontWeight: 700 }}>{m.poll.question}</div>

              <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                {m.poll.options.map((opt, idx) => {
                  const picked = m.poll.myVote === idx;
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => onVotePoll?.(m.dbId, idx)}   // you implement
                      style={{
                        textAlign: "left",
                        padding: "8px 10px",
                        borderRadius: 10,
                        border: picked ? "1px solid #111" : "1px solid #ddd",
                        background: "white",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        gap: 10,
                      }}
                    >
                      <span>{opt.text}</span>
                      <span style={{ opacity: 0.7 }}>{opt.count ?? 0}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}



          {/* Reaction chips row */}
          {reactions.length ? (
            <div
              ref={chipsWrapRef}
              style={{ marginTop: 8, display: "flex", gap: 6, flexWrap: "wrap", position: "relative" }}
              onMouseLeave={() => { setHoverEmoji(null); setAnchorEl(null); }}
            >
              {reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={() => applyReaction(r.emoji)}
                  onMouseEnter={(e) => {
                    setHoverEmoji(r.emoji);
                    setAnchorEl(e.currentTarget);
                    loadReactionUsers(); // fetch once per message
                  }}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    padding: "2px 8px",
                    borderRadius: 999,
                    border: r.me ? "1px solid #999" : "1px solid #ddd",
                    background: "white",
                    cursor: "pointer",
                    fontSize: 13,
                  }}
                >
                  <span>{r.emoji}</span>
                  <span style={{ opacity: 0.8 }}>{r.count}</span>
                </button>
              ))}

              {/* ✅ ONE popup only, rendered once */}
              {hoverEmoji && anchorEl ? (
                <ReactionPopup
                  emoji={hoverEmoji}
                  anchorEl={anchorEl}
                  wrapEl={chipsWrapRef.current}
                  loading={rxLoading}
                  detail={rxDetail}
                  myEmail={myEmail}
                />
              ) : null}
            </div>
          ) : null}

        </>
      ) : (
        <div style={{ fontSize: 13, opacity: 0.55, fontStyle: "italic", padding: "4px 2px" }}>
          Message deleted
        </div>
      )}

    </div>
  );
}


function ReactionPopup({ emoji, anchorEl, wrapEl, loading, detail, myEmail }) {
  // compute position relative to the chips wrapper
  const [pos, setPos] = React.useState({ left: 0, top: 0 });

  React.useEffect(() => {
    if (!anchorEl || !wrapEl) return;
    const a = anchorEl.getBoundingClientRect();
    const w = wrapEl.getBoundingClientRect();

    // position popup just under the hovered chip
    setPos({
      left: a.left - w.left,
      top: a.bottom - w.top + 6,
    });
  }, [anchorEl, wrapEl, emoji]);

  let names = [];
  if (!loading && detail?.items) {
    const hit = detail.items.find((x) => x.emoji === emoji);
    names = (hit?.users || []).map((u) => (u === myEmail ? "You" : u));
  }

  const max = 8;
  const shown = names.slice(0, max);
  const more = names.length - shown.length;

  return (
    <div
      style={{
        position: "absolute",
        left: pos.left,
        top: pos.top,
        background: "white",
        border: "1px solid #e6e6e6",
        borderRadius: 12,
        padding: "8px 10px",
        boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
        zIndex: 30,
        maxWidth: 320,

        // ✅ horizontal layout
        display: "flex",
        alignItems: "center",
        gap: 8,
      }}
    >
      <span style={{ fontSize: 16 }}>{emoji}</span>

      {loading ? (
        <span style={{ fontSize: 12, opacity: 0.7 }}>Loading…</span>
      ) : (
        <ReactionPopover detail={detail} emoji={emoji} myEmail={myEmail} />
      )}

    </div>
  );
}


export async function http(path, opts = {}) {
  const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";
  const token = localStorage.getItem("gochat_token");
  const headers = { ...(opts.headers || {}) };
  if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers, cache: "no-store" });
  if (!res.ok) throw new Error(await res.text());
  if (res.status === 204) return null;
  const text = await res.text(); return text ? JSON.parse(text) : null;
}

function isNearBottom(el, thresholdPx = 80) {
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
  return distance < thresholdPx;
}

export default function MessageList({ roomId, messages, onMessageMenu, onOpenMedia, onToggleReaction, myUserId, myEmail, onVotePoll, selectMode, selectedIds, onToggleSelectId, onLoadOlder }) {
  const [atBottom, setAtBottom] = useState(true);
  const listRef = useRef(null);
  const byDbId = new Map();
  const scrollerRef = useRef(null);
  const bottomRef = useRef(null);
  const didScrollOnEnterRef = useRef(false);
  const [stickToBottom, setStickToBottom] = useState(true);

  for (const msg of messages) if (msg.dbId) byDbId.set(msg.dbId, msg);

  function scrollToBottom(behavior = "smooth") {
    const el = listRef?.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }

  // Track whether the user is near the bottom (so we know if we should autoscroll)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const onScroll = () => {
      setStickToBottom(isNearBottom(el));
    };

    // initialize
    onScroll();

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);


  // 1) Initial enter: scroll once when first messages appear
  useLayoutEffect(() => {
    if (didScrollOnEnterRef.current) return;
    if (!messages || messages.length === 0) return;

    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end" });
      didScrollOnEnterRef.current = true;
    });
  }, [messages?.length]);


  // 2) New messages: scroll if we're "sticking to bottom"
  useLayoutEffect(() => {
    if (!didScrollOnEnterRef.current) return;
    if (!stickToBottom) return;

    // Wait for layout to settle
    requestAnimationFrame(() => {
      bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    });
  }, [messages?.length, stickToBottom]);


  // reset when entering a different room (or re-entering)
  useLayoutEffect(() => {
    didScrollOnEnterRef.current = false;
  }, [roomId]);

  // scroll ONCE when messages are actually rendered
  useLayoutEffect(() => {
    if (didScrollOnEnterRef.current) return;
    if (!messages || messages.length === 0) return;

    const scroller = scrollerRef.current;
    if (!scroller) return;

    // wait a tick so layout is final (fonts, etc.)
    requestAnimationFrame(() => {
      // IMPORTANT: if your list uses column-reverse, bottom is scrollTop=0
      const flexDir = getComputedStyle(scroller).flexDirection;
      if (flexDir === "column-reverse") {
        scroller.scrollTop = 0;
      } else {
        bottomRef.current?.scrollIntoView({ block: "end" });
      }
      didScrollOnEnterRef.current = true;
    });
  }, [roomId, messages?.length]);


  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    function onScroll() {
      const threshold = 120; // px
      const near = el.scrollTop + el.clientHeight >= el.scrollHeight - threshold;
      setAtBottom(near);
    }

    onScroll(); // init
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);


  useEffect(() => { scrollToBottom("auto"); }, []);


  return (
    <div
      ref={scrollerRef}
      style={{
        padding: 12,
        height: "65vh",
        overflowY: "auto",
        border: "1px solid #eee",
        borderRadius: 12,
        position: "relative", // ✅ needed because ↓ button is absolute
      }}
      className="messageList"
    >
      <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
        <button
          type="button"
          onClick={() => onLoadOlder?.()}
          style={{
            padding: "8px 12px",
            borderRadius: 10,
            border: "1px solid #ddd",
            cursor: "pointer",
          }}
        >
          Load older messages
        </button>
      </div>



      {messages.length === 0 ? (
        <div style={{ opacity: 0.7 }}>No messages yet.</div>
      ) : (
        messages.map((m) => (
          <MessageItem
            key={m.id}
            m={m}
            API_BASE={API_BASE}
            onMessageMenu={onMessageMenu}
            byDbId={byDbId}
            onOpenMedia={onOpenMedia}
            onToggleReaction={onToggleReaction}
            myUserId={myUserId}
            myEmail={myEmail}
            onVotePoll={onVotePoll}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelectId={onToggleSelectId}
          />
        ))
      )}



      {!atBottom ? (
        <button
          type="button"
          onClick={() => scrollToBottom("smooth")}
          title="Jump to latest"
          style={{
            position: "absolute",
            right: 14,
            bottom: 14,
            width: 36,
            height: 36,
            borderRadius: 999,
            border: "1px solid #ddd",
            background: "white",
            cursor: "pointer",
            boxShadow: "0 8px 24px rgba(0,0,0,0.12)",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 500,
            fontSize: 18,
          }}
        >
          ↓
        </button>
      ) : null}


      <div ref={bottomRef} />

    </div>
  );

}

