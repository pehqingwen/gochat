import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import MessageList from "../components/MessageList.jsx";
import MessageInput from "../components/MessageInput.jsx";
import { http } from "../api/http";
import { connectWS } from "../ws/client.js";

export default function Room() {
  const { roomId } = useParams();

  // IMPORTANT: WS server expects numeric roomId for DB rooms.
  // If you navigate to /rooms/general, roomIDNum becomes NaN -> won't work for cross-browser.
  const roomIDNum = Number(roomId);

  const title = useMemo(() => `#${roomId}`, [roomId]);

  const [me, setMe] = useState(null);
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState({}); // { email: lastSeenMs }
  const [users, setUsers] = useState([]);

  const wsRef = useRef(null);
  const nextId = useRef(2);

  function wsSend(obj) {
    const ws = wsRef.current;
    console.log("wsSend attempt:", obj, "readyState=", ws?.readyState);
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
  }

  function onSendAttachment(info) {
    console.log("onSendAttachment called with:", info);
    wsSend({
      type: "message",
      roomId: roomIDNum,
      body: "", // optional
      attachment: info,
    });
  }

  // Load current user (for displaying your email)
  useEffect(() => {
    (async () => {
      try {
        const info = await http("/me");
        setMe(info);
      } catch {
        // ignore for now
      }
    })();
  }, []);

  // Auto-expire stale typers
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      setTypingUsers((prev) => {
        const next = {};
        for (const [email, ts] of Object.entries(prev)) {
          if (now - ts < 3000) next[email] = ts;
        }
        return next;
      });
    }, 800);
    return () => clearInterval(t);
  }, []);

  // WebSocket connect + handlers
  useEffect(() => {
    // Guard: require numeric room id for WS rooms
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) {
      console.log("Room ID is not numeric; WS join_room will not work:", roomId);
      return;
    }

    const ws = connectWS();
    wsRef.current = ws;

    ws.onopen = () => {
      console.log("WS OPEN");
      ws.send(JSON.stringify({ type: "join_room", roomId: roomIDNum }));
    };

    ws.onclose = (e) => console.log("WS CLOSE", e.code, e.reason);
    ws.onerror = (e) => console.log("WS ERROR", e);

    ws.onmessage = (evt) => {
      console.log("WS IN", evt.data);

      let data;
      try { data = JSON.parse(evt.data); } catch { return; }

      if (data.type === "typing" && data.roomId === roomIDNum) {
        setTypingUsers((prev) => {
          const next = { ...prev };
          if (data.isTyping) next[data.userEmail] = Date.now();
          else delete next[data.userEmail];
          return next;
        });
      }

      if (data.type === "message" && data.roomId === roomIDNum) {
        setMessages((prev) => [
          ...prev,
          {
            id: `m${Date.now()}`,
            userEmail: data.userEmail || "unknown",
            body: data.body || "",
            attachment: data.attachment || null,  // ✅ required
            createdAt: data.createdAt || Date.now(),
          },
        ]);
      }

      if (data.type === "user_list" && data.roomId === roomIDNum) {
        setUsers(Array.isArray(data.users) ? data.users : []);
      }

      if (data.type === "user_joined" && data.roomId === roomIDNum) {
        if (!data.userEmail) return;
        setUsers((prev) => {
          const exists = prev.some((u) => u.email === data.userEmail);
          if (exists) return prev;
          return [...prev, { email: data.userEmail, status: data.status || "active" }];
        });
      }

      if (data.type === "user_left" && data.roomId === roomIDNum) {
        if (!data.userEmail) return;
        setUsers((prev) => prev.filter((u) => u.email !== data.userEmail));
      }

      if (data.type === "presence" && data.roomId === roomIDNum) {
        if (!data.userEmail) return;
        setUsers((prev) =>
          prev.map((u) =>
            u.email === data.userEmail ? { ...u, status: data.status || "active" } : u
          )
        );
      }
    };

    return () => {
      try {
        ws.close();
      } catch { }
      wsRef.current = null;
    };
  }, [roomIDNum, roomId]);

  // Build typing text (optionally exclude yourself)
  const typers = Object.keys(typingUsers).filter((e) => e && e !== me?.email);

  const typingText = (() => {
    if (typers.length === 0) return "";
    if (typers.length === 1) return `${typers[0]} is typing…`;
    if (typers.length === 2) return `${typers[0]} and ${typers[1]} are typing…`;
    return `${typers.slice(0, -1).join(", ")}, and ${typers[typers.length - 1]} are typing…`;
  })();

  function onSend(body) {
    wsSend({ type: "message", roomId: roomIDNum, body });

    // local echo so sender sees it
    // setMessages((prev) => [
    //   ...prev,
    //   {
    //     id: `m${Date.now()}`,
    //     userEmail: me?.email || "me",
    //     body,
    //     createdAt: Date.now(),
    //   },
    // ]);
  }

  useEffect(() => {
  if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;

  let idleTimer = null;
  let lastSent = "active";
  const IDLE_MS = 60_000;

  const sendStatus = (status) => {
    if (status === lastSent) return;
    lastSent = status;
    wsSend({ type: "presence", roomId: roomIDNum, status });
  };

  const bump = () => {
    sendStatus("active");
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => sendStatus("idle"), IDLE_MS);
  };

  bump();

  const events = ["mousemove", "keydown", "mousedown", "touchstart", "focus"];
  events.forEach((ev) => window.addEventListener(ev, bump, { passive: true }));

  const onVis = () => (document.hidden ? sendStatus("idle") : bump());
  document.addEventListener("visibilitychange", onVis);

  return () => {
    events.forEach((ev) => window.removeEventListener(ev, bump));
    document.removeEventListener("visibilitychange", onVis);
    if (idleTimer) clearTimeout(idleTimer);
  };
}, [roomIDNum]);

useEffect(() => {
  if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;

  (async () => {
    try {
      const rows = await http(`/rooms/${roomIDNum}/messages?limit=50`);
      const normalized = (rows || []).slice().reverse().map((m) => ({
        id: `db_${m.id}`,
        userEmail: m.userEmail,
        body: m.body || "",
        attachment: m.attachment || null,
        createdAt: m.createdAt || Date.now(),
      }));
      setMessages(normalized);
    } catch (e) {
      console.warn("load messages failed", e);
    }
  })();
}, [roomIDNum]);

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Room</div>
          <h2 style={{ margin: 0 }}>{title}</h2>
          <div style={{ fontSize: 12, opacity: 0.7 }}>
            {me?.email ? `Logged in as ${me.email}` : ""}
          </div>
        </div>
        <Link to="/rooms" style={{ textDecoration: "none" }}>← Back</Link>
      </div>

      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 260px", gap: 12 }}>
        {/* MAIN CHAT */}
        <div>
          <MessageList messages={messages} />

          {typingText ? (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
              {typingText}
            </div>
          ) : null}

          <MessageInput
            onSend={onSend}
            onTyping={(isTyping) => wsSend({ type: "typing", roomId: roomIDNum, isTyping })}
            onSendAttachment={onSendAttachment}
          />

        </div>

        {/* SIDEBAR */}
        <div
          style={{
            border: "1px solid #eee",
            borderRadius: 12,
            padding: 12,
            height: "65vh",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={{ fontWeight: 800 }}>Online</div>
            <div style={{ fontSize: 12, opacity: 0.7 }}>{users.length}</div>
          </div>

          <div style={{ marginTop: 10, overflowY: "auto" }}>
            {users.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No one online</div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {users.map((u) => (
                  <div
                    key={u.email}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: 10,
                      border: "1px solid #f0f0f0",
                    }}
                    title={u.email}
                  >
                    <div
                      style={{
                        width: 10,
                        height: 10,
                        borderRadius: 999,
                        background: u.status === "idle" ? "#f59e0b" : "#22c55e", // idle=amber, active=green
                        flexShrink: 0,
                      }}
                    />
                    <div style={{ fontSize: 13, overflow: "hidden", textOverflow: "ellipsis" }}>
                      {u.email}{u.email === me?.email ? " (you)" : ""}{" "}
                      <span style={{ fontSize: 12, opacity: 0.7 }}>
                        {u.status === "idle" ? "away" : "online"}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

    </div>
  );
}
