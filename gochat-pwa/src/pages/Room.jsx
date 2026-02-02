import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import { Link, useParams } from "react-router-dom";
import MessageList from "../components/MessageList.jsx";
import MessageInput from "../components/MessageInput.jsx";
import { http } from "../api/http";
import { useCall } from "../contexts/CallContext";
import { useNavigate } from "react-router-dom";
import { useWS } from "../contexts/WSContext";

export default function Room() {
  const { roomId } = useParams();
  const listRef = useRef(null);
  const shouldAutoScrollRef = useRef(true);
  const lastMarkedReadRef = useRef(0);
  const navigate = useNavigate();

  const { setMe: setCallMe, meEmail, syncCall, setRoomId, startCall, joinCall, cleanupCall } = useCall();

  // IMPORTANT: WS server expects numeric roomId for DB rooms.
  // If you navigate to /rooms/general, roomIDNum becomes NaN -> won't work for cross-browser.
  const roomIDNum = Number(roomId);
  const title = useMemo(() => `#${roomId}`, [roomId]);
  const [viewer, setViewer] = useState(null);
  // viewer = { kind: "image"|"video", src: string, title?: string }

  const [me, setMe] = useState(null);
  const [messages, setMessages] = useState([]);
  const [typingUsers, setTypingUsers] = useState({}); // { email: lastSeenMs }
  const [users, setUsers] = useState([]);
  const [replyTo, setReplyTo] = useState(null); // store the message object
  const [q, setQ] = useState("");
  const [searching, setSearching] = useState(false);

  const [editingMsg, setEditingMsg] = useState(null);  // message object
  const [editText, setEditText] = useState("");
  const [menuMsg, setMenuMsg] = useState(null);
  const [showStarred, setShowStarred] = useState(false);
  const listToShow = showStarred ? messages.filter((m) => m.starred) : messages;
  const latestMsgIdRef = useRef(0);
  const [editingPoll, setEditingPoll] = useState(null);
  // { messageId, question, options[] } or null
  //   SELECT id, room_id, kind, poll
  // FROM messages
  // WHERE kind = 'poll'
  // ORDER BY id DESC
  // LIMIT 5;

  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [searchQuery, setSearchQuery] = useState(""); // the active query used for results
  const [call, setCall] = useState(null); // {active, roomId, host, participants, startedAt}

  const inSearch = !!searchQuery.trim();
  const localStreamRef = useRef(null);
  const [localStreamOn, setLocalStreamOn] = useState(false);

  const myEmail = me?.email || "";
  const inCall = !!call?.active && (call.participants || []).includes(myEmail);
  const isHost = !!call?.active && call.host === myEmail;
  const [callOverlayHidden, setCallOverlayHidden] = useState(false);
  const [now, setNow] = useState(Date.now());
  const seconds = call?.startedAt ? Math.floor((now - call.startedAt) / 1000) : 0;
  const pcsRef = useRef(new Map()); // key: peerEmail -> RTCPeerConnection
  const [remotePeers, setRemotePeers] = useState([]); // [{ email, stream }]
  const [callState, setCallState] = useState(null);
  // callState shape: { active, roomId, host, participants, startedAt }
  const [callInvite, setCallInvite] = useState(null);
  // { roomId, host, createdAt }
  const localVideoRef = useRef(null);
  const [callOpen, setCallOpen] = useState(false); // whether overlay is open
  const [roomParticipants, setRoomParticipants] = useState([]);
  const callParticipants = callState?.participants || [];
  const { wsRef, wsSend } = useWS();


  useEffect(() => {
    if (me) setCallMe(me); // push local me into CallContext
  }, [me, setCallMe]);

  function formatCallTime(ms) {
    if (!ms) return "";
    const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }


  useEffect(() => {
    if (!call?.active) return;
    setCallOverlayHidden(false);
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [call?.active]);


  useEffect(() => {
    if (call?.active && call.host === me?.email) {
      navigate(`/call/${roomIDNum}`);
    }
  }, [call?.active, call?.host, me?.email, roomIDNum]);


  useEffect(() => {
    if (localVideoRef.current && localStreamRef.current) {
      localVideoRef.current.srcObject = localStreamRef.current;
    }
  }, [localStreamOn]);


  async function getLocalStream() {
    if (localStreamRef.current) return localStreamRef.current;

    const s = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStreamRef.current = s;
    return s;
  }

  async function createPeer(remoteEmail) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    const stream = await getLocalStream();       // ✅ now stream is defined
    stream.getTracks().forEach((t) => pc.addTrack(t, stream));

    return pc;
  }

  useEffect(() => {
    function onUnload() {
      try { wsSend({ type: "call_leave", roomId: roomIDNum }); } catch { }
    }
    window.addEventListener("beforeunload", onUnload);
    return () => window.removeEventListener("beforeunload", onUnload);
  }, [roomIDNum, callState?.active]);


  function toggleSelectId(id) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelectedIds(new Set());
  }

  function splitSelectionForDelete() {
    const ids = Array.from(selectedIds);

    const byId = new Map(messages.map(m => [m.dbId, m]));
    const deletable = [];
    const blocked = [];

    for (const id of ids) {
      const m = byId.get(id);
      if (!m || m.deleted) continue;
      if (m.userEmail === me?.email) deletable.push(id);
      else blocked.push(id);
    }
    return { deletable, blocked };
  }

  async function bulkDelete() {
    const { deletable, blocked } = splitSelectionForDelete();

    if (deletable.length === 0) {
      alert("You can only mass delete your own messages.");
      return;
    }

    let msg = `Delete ${deletable.length} message(s)?`;
    if (blocked.length > 0) {
      msg += `\n\n${blocked.length} selected message(s) are not yours and will be skipped.`;
    }
    if (!confirm(msg)) return;

    // optimistic UI: only mark deletable
    setMessages(prev =>
      prev.map(m =>
        deletable.includes(m.dbId)
          ? { ...m, deleted: true, body: "", attachment: null }
          : m
      )
    );

    await http(`/messages/bulk/delete`, {
      method: "POST",
      body: JSON.stringify({ messageIds: deletable }),
    });

    // Keep selection mode? up to you.
    // Usually: clear everything after action
    exitSelectMode();
  }

  async function bulkStar() {
    const ids = Array.from(selectedIds).filter(Boolean);
    if (ids.length === 0) return;

    await http(`/messages/bulk/star`, {
      method: "POST",
      body: JSON.stringify({ messageIds: ids }),
    });

    setMessages(prev =>
      prev.map(m => (selectedIds.has(m.dbId) ? { ...m, starred: true } : m))
    );

    exitSelectMode();
  }


  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;
    setRoomId(roomIDNum);
    syncCall(roomIDNum);
  }, [roomIDNum, setRoomId, syncCall]);


  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;
    setRoomId(roomIDNum);
  }, [roomIDNum, setRoomId]);


  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;
    loadRecent().catch(e => console.warn("load recent failed", e));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomIDNum]);


  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;

    const ws = wsRef.current;
    if (!ws) return;

    const join = () => {
      wsSend({ type: "join_room", roomId: roomIDNum });
      wsSend({ type: "presence", roomId: roomIDNum, status: "active" });
      wsSend({ type: "call_sync", roomId: roomIDNum });
    };

    if (ws.readyState === WebSocket.OPEN) join();
    else ws.addEventListener("open", join, { once: true });

    return () => {
      try { ws.removeEventListener("open", join); } catch { }
    };
  }, [roomIDNum, wsRef, wsSend]);


  async function loadOlder() {
    const oldest = messages.find(m => m.dbId)?.dbId;
    if (!oldest) return;

    let rows;

    if (inSearch) {
      // ✅ load older results that match the current keyword
      rows = await http(
        `/rooms/${roomIDNum}/messages/search?q=${encodeURIComponent(searchQuery)}&limit=50&before=${oldest}`
      );
    } else {
      // ✅ normal older history
      rows = await http(`/rooms/${roomIDNum}/messages?limit=50&before=${oldest}`);
    }

    const olderNormalized = normalizeRows(rows);
    setMessages(prev => [...olderNormalized, ...prev]);
  }


  function openPollEdit(m) {
    setEditingPoll({
      messageId: m.dbId,
      question: m.poll?.question || "",
      options: (m.poll?.options || []).map(o => o.text || ""),
    });
  }

  useEffect(() => {
    latestMsgIdRef.current = messages.length ? messages[messages.length - 1].dbId : 0;
  }, [messages]);

  const token = localStorage.getItem("gochat_token");
  // console.log("gochat_token exists?", !!token, token?.slice(0, 20));

  function isNearBottom(el, px = 120) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < px;
  }

  function scrollToBottom() {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }

  async function markRead(latestDbId) {
    if (!latestDbId) return;
    await http(`/rooms/${roomIDNum}/read`, {
      method: "POST",
      body: JSON.stringify({ lastReadMessageId: latestDbId }),
    });
  }

  function upsertReactionChip(reactions, emoji, newCount, meDidIt, evType) {
    const list = Array.isArray(reactions) ? [...reactions] : [];
    const idx = list.findIndex((x) => x.emoji === emoji);

    // if count becomes 0, remove chip
    if (!newCount || newCount <= 0) {
      if (idx >= 0) list.splice(idx, 1);
      return list;
    }

    if (idx >= 0) {
      list[idx] = {
        ...list[idx],
        count: newCount,
        // update "me" only if event was caused by me (optional)
        me: meDidIt ? (evType === "reaction_added") : list[idx].me,
      };
    } else {
      list.push({ emoji, count: newCount, me: meDidIt && evType === "reaction_added" });
    }

    // keep stable order (optional)
    list.sort((a, b) => a.emoji.localeCompare(b.emoji));
    return list;
  }

  function applyReactionEvent(ev) {
    const myUserId = me?.id;

    setMessages(prev =>
      prev.map(msg => {
        const msgId = msg.dbId ?? msg.id;
        if (msgId !== ev.messageId) return msg;

        const reactions = Array.isArray(msg.reactions) ? [...msg.reactions] : [];
        const idx = reactions.findIndex(r => r.emoji === ev.emoji);

        const meChanged = myUserId && ev.userId === myUserId;
        const meValue = ev.type === "reaction_added";

        if (ev.count <= 0) {
          // remove emoji group if count goes to 0
          if (idx >= 0) reactions.splice(idx, 1);
        } else if (idx >= 0) {
          reactions[idx] = {
            ...reactions[idx],
            count: ev.count,
            ...(meChanged ? { me: meValue } : null),
          };
        } else {
          reactions.push({
            emoji: ev.emoji,
            count: ev.count,
            me: meChanged ? meValue : false,
          });
        }

        return { ...msg, reactions };
      })
    );
  }

  function handleListScroll() {
    const el = listRef.current;
    if (!el) return;

    if (isNearBottom(el)) {
      // user returned to bottom -> mark everything currently loaded as read
      setTimeout(() => {
        const latest = messages.length ? messages[messages.length - 1].dbId : 0;
        markRead(latestMsgIdRef.current);
      }, 0);
    }
  }


  async function onToggleReaction(m, emoji) {
    const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";
    const token = localStorage.getItem("gochat_token");

    const roomId = m.roomId ?? Number(roomIDNum);   // use your real room id here
    const messageId = m.dbId ?? m.id;

    const res = await fetch(`${API_BASE}/reactions/toggle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ roomId, messageId, emoji }),
    });

    if (!res.ok) throw new Error(await res.text());

    // IMPORTANT: backend returns the reaction event JSON
    const ev = await res.json();
    applyReactionEvent(ev); // update UI immediately
  }

  function dedupeUsers(list) {
    const m = new Map();
    for (const u of list || []) {
      const email = typeof u === "string" ? u : u.email;
      if (!email) continue;
      const status = typeof u === "string" ? "active" : (u.status || "active");
      m.set(email, { email, status }); // last wins
    }
    return Array.from(m.values());
  }

  function normalizeRows(rows) {
    return (rows || []).slice().reverse().map((m) => ({
      id: `db_${m.id}`,
      dbId: m.id,
      deleted: !!m.deleted,
      edited: !!m.edited,
      starred: !!m.starred,
      replyToId: m.replyToId || 0,
      userEmail: m.userEmail,
      body: m.deleted ? "" : (m.body || ""),
      attachment: m.deleted ? null : (m.attachment || null),
      createdAt: m.createdAt || Date.now(),
      kind: m.kind || "text",
      poll: m.poll || null,
      reactions: Array.isArray(m.reactions) ? m.reactions : [],
    }));
  }


  async function runSearch(query) {
    const qq = query.trim();

    // If empty => exit search mode and show normal messages
    if (!qq) {
      setSearchQuery("");
      await loadRecent(); // we'll add this below
      return;
    }

    setSearchQuery(qq);

    setSearching(true);
    try {
      const rows = await http(
        `/rooms/${roomIDNum}/messages/search?q=${encodeURIComponent(qq)}&limit=50`
      );
      setMessages(normalizeRows(rows));
    } catch (e) {
      alert(e?.message || "Search failed");
    } finally {
      setSearching(false);
    }
  }


  async function loadRecent() {
    const rows = await http(`/rooms/${roomIDNum}/messages?limit=50`);
    setMessages(normalizeRows(rows));
  }


  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;

    (async () => {
      try {
        const data = await http(`/rooms/${roomIDNum}/messages?limit=50`);

        console.log("messages api typeof:", typeof data);
        console.log("messages api isArray:", Array.isArray(data));
        console.log("messages api keys:", data && typeof data === "object" ? Object.keys(data) : null);
        console.log("messages api sample:", Array.isArray(data) ? data[0] : data?.items?.[0]);

        const normalized = normalizeRows(data);
        console.log("normalized length:", normalized.length, "first:", normalized[0]);

        setMessages(normalized);
        requestAnimationFrame(() => scrollToBottom?.("auto"));

        const latest = normalized.length ? normalized[normalized.length - 1].dbId : 0;
        markRead?.(latest).catch(() => { });
      } catch (e) {
        console.warn("load messages failed", e);
      }
    })();
  }, [roomIDNum]);


  function normalizeRows(data) {
    const rows = Array.isArray(data) ? data : (Array.isArray(data?.items) ? data.items : []);

    return rows.slice().reverse().map((m) => ({
      id: `db_${m.id}`,
      dbId: m.id,

      kind: m.kind || "text",
      poll: m.poll || null,

      deleted: !!m.deleted,
      edited: !!m.edited,
      starred: !!m.starred,

      replyToId: m.replyToId || 0,
      userEmail: m.userEmail,
      body: m.deleted ? "" : (m.body || ""),
      attachment: m.deleted ? null : (m.attachment || null),
      createdAt: m.createdAt || Date.now(),

      reactions: Array.isArray(m.reactions) ? m.reactions : [],
    }));
  }

  async function runSearch(query) {
    const qq = query.trim();
    if (!qq) return; // do nothing if empty
    setSearching(true);
    try {
      const rows = await http(`/rooms/${roomIDNum}/messages/search?q=${encodeURIComponent(qq)}&limit=50`);
      setMessages(normalizeRows(rows));
    } finally {
      setSearching(false);
    }
  }

  function onMessageMenu(m) {
    setMenuMsg(m);
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


  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;

    // enter room
    wsSend({ type: "join_room", roomId: roomIDNum });
    wsSend({ type: "presence", roomId: roomIDNum, status: "active" });
    wsSend({ type: "call_sync", roomId: roomIDNum });

    return () => {
      // ✅ leave room when navigating away
      wsSend({ type: "leave_room", roomId: roomIDNum });
    };
  }, [roomIDNum, wsSend]);


  useEffect(() => {
    const ws = wsRef.current;
    if (!ws) return;

    const onMessage = async (evt) => {
      console.log("[WS RX raw]", evt.data);

      let data;
      try { data = JSON.parse(evt.data); } catch { return; }
      console.log("[WS RX parsed]", data);

      if (data.type === "typing" && Number(data.roomId) === Number(roomIDNum)) {
        setTypingUsers((prev) => {
          const next = { ...prev };
          if (data.isTyping) next[data.userEmail] = Date.now();
          else delete next[data.userEmail];
          return next;
        });
      }


      if (data.type === "message" && Number(data.roomId) === Number(roomIDNum)) {
        const el = listRef.current;
        const wasNearBottom = el ? isNearBottom(el) : true;

        const mid = Number(data.messageId) || 0;

        setMessages((prev) => {
          if (mid && prev.some((m) => m.dbId === mid)) return prev; // dedupe

          return [
            ...prev,
            {
              id: `db_${mid || Date.now()}`,
              dbId: mid,
              deleted: !!data.deleted,
              edited: !!data.edited,
              starred: !!data.starred,
              replyToId: data.replyToId || 0,
              userEmail: data.userEmail || "unknown",
              body: data.body || "",
              attachment: data.attachment || null,
              createdAt: data.createdAt || Date.now(),
              reactions: Array.isArray(data.reactions) ? data.reactions : [],
              kind: data.kind || "text",
              poll: data.poll || null,
            },
          ];
        });

        if (wasNearBottom) {
          requestAnimationFrame(() => {
            scrollToBottom();
            markRead(mid);
          });
        }
      }


      if (data.type === "message_deleted" && Number(data.roomId) === Number(roomIDNum)) {
        const mid = Number(data.messageId);
        setMessages((prev) =>
          prev.map((m) => {
            const hit = (m.dbId && m.dbId === mid) || m.id === `db_${mid}`;
            return hit ? { ...m, deleted: true, body: "", attachment: null } : m;
          })
        );
      }

      if (data.type === "message_edited" && Number(data.roomId) === Number(roomIDNum)) {
        const mid = Number(data.messageId);
        setMessages((prev) =>
          prev.map((m) =>
            m.dbId === mid || m.id === `db_${mid}`
              ? { ...m, body: data.body || "", edited: true }
              : m
          )
        );
      }


      if (data.type === "user_list" && Number(data.roomId) === Number(roomIDNum)) {
        const normalized = (data.users || []).map((u) => {
          // backend might send ["a@x.com", "b@x.com"]
          if (typeof u === "string") return { email: u, status: "active" };

          // backend might send {Email:"", Status:""} (no json tags)
          const email = u.email || u.Email || u.userEmail || u.UserEmail || "";
          const status = u.status || u.Status || "active";
          return { email, status };
        }).filter(u => u.email);

        setUsers(dedupeUsers(normalized));
        console.log("[user_list normalized]", normalized);
      }


      if (data.type === "user_joined" && Number(data.roomId) === Number(roomIDNum)) {
        console.log("[user_joined]", data.userEmail);

        // If you want it to appear as a system chat message:
        setMessages((prev) => [
          ...prev,
          {
            id: `sys_join_${Date.now()}`,
            kind: "system",
            body: `👋 ${data.userEmail} joined the room`,
            createdAt: Date.now(),
            attachment: null,
          },
        ]);
      }


      if (data.type === "user_left" && Number(data.roomId) === Number(roomIDNum)) {
        if (!data.userEmail) return;
        setUsers((prev) => prev.filter((u) => u.email !== data.userEmail));
      }

      if ((data.type === "reaction_added" || data.type === "reaction_removed") && Number(data.roomId) === Number(roomIDNum)) {
        const mid = Number(data.messageId);
        const emoji = data.emoji;
        const count = Number(data.count); // server should send updated count
        const meDidIt = data.userEmail && me?.email && data.userEmail === me.email;

        if (!mid || !emoji) return;

        setMessages((prev) =>
          prev.map((m) => {
            if (m.dbId !== mid) return m;
            return {
              ...m,
              reactions: upsertReactionChip(m.reactions, emoji, count, meDidIt, data.type),
            };
          })
        );

      }


      if (data.type === "presence" && Number(data.roomId) === Number(roomIDNum)) {
        const email = data.userEmail;
        const status = data.status || "active";

        setUsers((prev) => {
          const next = Array.isArray(prev) ? [...prev] : [];

          // ✅ remove if inactive
          if (status === "inactive") {
            return next.filter((u) => u.email !== email);
          }

          // ✅ otherwise upsert active/idle
          const idx = next.findIndex((u) => u.email === email);
          if (idx >= 0) next[idx] = { ...next[idx], status };
          else next.push({ email, status });

          return dedupeUsers(next);
        });

        return;
      }


      if (data.type === "poll_updated" && Number(data.roomId) === Number(roomIDNum)) {
        const mid = Number(data.messageId);
        setMessages(prev => prev.map(m => (m.dbId === mid ? { ...m, poll: data.poll, kind: "poll" } : m)));
      }

      if (data.type === "call_state" && Number(data.roomId) === Number(roomIDNum)) {
        // console.log("CALL STATE IN", data.call);
        setCall(data.call || null);
        setCallState(data.call || null);

        if (!data.call?.active) cleanupCall();
      }


      if (data.type === "system" && Number(data.roomId) === Number(roomIDNum)) {
        const createdAt = Number(data.createdAt) || Date.now();

        // Prefer server eventId; otherwise generate one
        const baseId = data.eventId
          ? `sys_${data.eventId}`
          : `sys_${createdAt}_${Math.random().toString(36).slice(2, 8)}`;

        setMessages((prev) => {
          // ✅ dedupe: if we already inserted this event, do nothing
          if (prev.some((m) => m.id === baseId)) return prev;

          return [
            ...prev,
            {
              id: baseId,            // ✅ unique + deduped
              dbId: 0,
              kind: "system",
              userEmail: "",
              body: data.text || "",
              createdAt,
              deleted: false,
              edited: false,
              starred: false,
              attachment: null,
            },
          ];
        });
      }


      if (data.type === "call_invite" && Number(data.roomId) === Number(roomIDNum)) {
        // don't prompt the host who started it
        if (data.host === me?.email) return;

        // show prompt
        setCallInvite({ roomId: data.roomId, host: data.host, createdAt: data.createdAt });
      }


    };


    ws.addEventListener("message", onMessage);

    return () => {
      ws.removeEventListener("message", onMessage);
    };
  }, [wsRef, roomIDNum]);



  // Build typing text (optionally exclude yourself)
  const typers = Object.keys(typingUsers).filter((e) => e && e !== me?.email);

  const typingText = (() => {
    if (typers.length === 0) return "";
    if (typers.length === 1) return `${typers[0]} is typing…`;
    if (typers.length === 2) return `${typers[0]} and ${typers[1]} are typing…`;
    return `${typers.slice(0, -1).join(", ")}, and ${typers[typers.length - 1]} are typing…`;
  })();

  function onSend(body, attachment) {
    // always send via WS (and let server echo back)
    wsSend({
      type: "message",
      roomId: roomIDNum,
      body: body || "",
      attachment: attachment || null,
      replyToId: replyTo?.dbId || 0, // if you have replies
    });

    setReplyTo(null);
  }

  async function deleteSelected(selectedIds) {
    if (selectedIds.length === 0) return;
    if (!confirm(`Delete ${selectedIds.length} message(s)?`)) return;

    // run sequentially (simpler to debug)
    for (const id of selectedIds) {
      const m = messages.find(x => x.dbId === id);
      if (!m) continue;
      try {
        await deleteMessage(m); // ✅ uses your existing function
      } catch (e) {
        console.warn("delete failed", id, e);
      }
    }
  }

  async function deleteMessage(m) {
    await http(`/messages/${m.dbId}`, { method: "DELETE" });
    setMessages((prev) =>
      prev.map((x) =>
        x.dbId === m.dbId ? { ...x, deleted: true, body: "", attachment: null } : x
      )
    );
  }

  async function editMessage(m, newBody) {
    const body = (newBody || "").trim();
    if (!body) return;

    await http(`/messages/${m.dbId}`, {
      method: "PUT",
      body: JSON.stringify({ body }),
    });

    // optional optimistic update (WS will also update everyone)
    setMessages((prev) =>
      prev.map((x) =>
        x.dbId === m.dbId ? { ...x, body, edited: true } : x
      )
    );
  }

  async function toggleStar(m) {
    if (!m?.dbId) return;

    const next = !m.starred;

    // optimistic UI
    setMessages((prev) =>
      prev.map((x) => (x.dbId === m.dbId ? { ...x, starred: next } : x))
    );

    try {
      if (next) {
        await http(`/messages/${m.dbId}/star`, { method: "POST" });
      } else {
        await http(`/messages/${m.dbId}/star`, { method: "DELETE" });
      }
    } catch (e) {
      // rollback
      setMessages((prev) =>
        prev.map((x) => (x.dbId === m.dbId ? { ...x, starred: !next } : x))
      );
      alert(e?.message || "Star failed");
    }
  }

  async function onVotePoll(messageId, optionIdx) {
    const res = await http(`/polls/${messageId}/vote`, {
      method: "POST",
      body: JSON.stringify({ optionIdx }),
    });

    const poll = res?.poll || res?.data?.poll; // depending on your http wrapper
    if (poll) {
      setMessages(prev =>
        prev.map(m => (m.dbId === messageId ? { ...m, kind: "poll", poll } : m))
      );
    }
  }

  useEffect(() => {
    if (!Number.isFinite(roomIDNum) || roomIDNum <= 0) return;

    let idleTimer = null;
    let lastSent = "active";
    const IDLE_MS = 60_000;

    const sendStatus = (status) => {
      if (status === lastSent) return;

      // only update lastSent if it actually went out
      const ok = wsSend({ type: "presence", roomId: roomIDNum, status });
      if (ok) lastSent = status;
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
    if (!viewer) return;
    const onKey = (e) => { if (e.key === "Escape") setViewer(null); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [viewer]);



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

      <div
        style={{
          marginTop: 14,
          display: "grid",
          gridTemplateColumns: window.innerWidth < 760 ? "1fr" : "1fr 260px",
          gap: 12,
        }}
      >
        {/* MAIN CHAT */}
        <div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>

            <button
              type="button"
              onClick={() => setShowStarred(false)}
              style={{
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid #ddd",
                background: showStarred ? "white" : "#f5f5f5",
              }}
            >
              All
            </button>

            <button
              type="button"
              onClick={() => setShowStarred(true)}
              style={{
                padding: "8px 10px",
                borderRadius: 12,
                border: "1px solid #ddd",
                background: showStarred ? "#f5f5f5" : "white",
              }}
            >
              ⭐ Starred
            </button>


            <button onClick={startCall}>📹 Start Call</button>


            <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.7 }}>
              {messages.filter((m) => m.starred).length} starred
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <input
              value={q}
              onChange={(e) => {
                const v = e.target.value;
                setQ(v);
                if (v.trim() === "") {
                  (async () => {
                    const data = await http(`/rooms/${roomIDNum}/messages?limit=50`);
                    setMessages(normalizeRows(data));
                  })().catch(console.warn);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") runSearch(q);
              }}
              placeholder="Search this room…"
              style={{
                flex: 1,
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid #ddd",
              }}
            />

            <button
              onClick={() => runSearch(q)}
              disabled={searching}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd" }}
            >
              {searching ? "Searching…" : "Search"}
            </button>

          </div>


          <div style={{
            padding: 12,
            height: "65vh",
            overflowY: "auto",
            overflowX: "hidden",   // ✅ add this
            border: "1px solid #eee",
            borderRadius: 12
          }}>

            <MessageList roomId={roomIDNum} messages={listToShow} onMessageMenu={onMessageMenu} onOpenMedia={(v) => setViewer(v)} onToggleReaction={onToggleReaction} myUserId={me?.id} listRef={listRef} onScroll={handleListScroll} myEmail={me?.email} onVotePoll={onVotePoll} selectMode={selectMode} selectedIds={selectedIds} onToggleSelectId={toggleSelectId} onLoadOlder={loadOlder} />

          </div>


          {menuMsg ? (
            <div
              onClick={() =>

                setMenuMsg(null)}

              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.25)",
                display: "flex",
                alignItems: "center",          // ✅ center vertically
                justifyContent: "center",      // ✅ center horizontally
                padding: 16,
                zIndex: 9999,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "min(520px, 100%)",
                  borderRadius: 16,
                  border: "1px solid #eee",
                  background: "white",
                  padding: 14,
                  maxHeight: "80vh",           // ✅ prevent off-screen
                  overflowY: "auto",           // ✅ scroll inside if needed
                  boxShadow: "0 10px 30px rgba(0,0,0,0.15)", // optional
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 10 }}>Message options</div>

                <button
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  onClick={() => {
                    setReplyTo(menuMsg);       // if you implemented reply state
                    setMenuMsg(null);
                  }}
                >
                  Reply
                </button>

                <div style={{ height: 8 }} />

                <button
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  disabled={menuMsg.deleted} // optional
                  onClick={async () => {
                    const msg = menuMsg;          // capture
                    setMenuMsg(null);
                    if (!msg?.dbId) return alert("Cannot star: missing dbId");           // close menu
                    try {
                      await toggleStar(msg);
                    } catch { }
                  }}
                >
                  {menuMsg.starred ? "Unstar" : "Star"}
                </button>


                {/* select */}
                <div style={{ height: 8 }} />

                <button
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  disabled={!menuMsg?.dbId || menuMsg.deleted}
                  title={
                    !menuMsg?.dbId
                      ? "Cannot select: missing dbId"
                      : menuMsg.deleted
                        ? "Deleted messages cannot be selected"
                        : ""
                  }
                  onClick={() => {
                    const msg = menuMsg;
                    setMenuMsg(null);
                    if (!msg?.dbId) return;

                    setSelectMode(true);
                    toggleSelectId(msg.dbId);
                  }}
                >
                  {menuMsg?.dbId && selectedIds?.has(menuMsg.dbId) ? "Unselect" : "Select"}
                </button>


                <div style={{ height: 8 }} />

                <button
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  disabled={menuMsg.userEmail !== me?.email || menuMsg.deleted}
                  title={
                    menuMsg.userEmail !== me?.email
                      ? "You can only edit your own messages"
                      : menuMsg.deleted
                        ? "Deleted messages cannot be edited"
                        : ""
                  }
                  onClick={() => {
                    const msg = menuMsg;   // capture
                    setMenuMsg(null);      // close menu

                    if (!msg) return;

                    // ✅ If it's a poll -> open poll edit modal
                    if (msg.kind === "poll") {
                      if (!msg.dbId) return alert("Cannot edit poll: missing dbId");
                      openPollEdit(msg);
                      return;
                    }

                    // ✅ Otherwise -> normal text edit
                    setEditingMsg(msg);
                    setEditText(msg.body || "");
                  }}
                >
                  Edit
                </button>

                <div style={{ height: 8 }} />

                <button
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  onClick={() => {
                    deleteMessage(menuMsg);    // your delete function
                    setMenuMsg(null);
                  }}
                  disabled={menuMsg.userEmail !== me?.email}
                  title={menuMsg.userEmail !== me?.email ? "You can only delete your own messages" : ""}
                >
                  Delete
                </button>

                <div style={{ height: 8 }} />

                <button
                  style={{ width: "100%", padding: 12, borderRadius: 12, border: "1px solid #ddd" }}
                  onClick={() => setMenuMsg(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          {replyTo ? (
            <div style={{ marginTop: 10, padding: 10, border: "1px solid #eee", borderRadius: 12 }}>
              <div style={{ fontSize: 12, opacity: 0.7 }}>Replying to {replyTo.userEmail}</div>
              <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                {replyTo.deleted ? "(deleted)" : (replyTo.body || replyTo.attachment?.filename || "(attachment)")}
              </div>
              <button type="button" onClick={() => setReplyTo(null)} style={{ marginTop: 6 }}>Cancel</button>
            </div>
          ) : null}

          {typingText ? (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 8 }}>
              {typingText}
            </div>
          ) : null}

          <MessageInput
            onSend={onSend}
            onTyping={(isTyping) => wsSend({ type: "typing", roomId: roomIDNum, isTyping })}
            roomIDNum={roomIDNum}
            editingPoll={editingPoll}
            onCloseEditPoll={() => setEditingPoll(null)}
          />

          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            WS state: {wsRef.current?.readyState ?? "none"} (1=OPEN)
          </div>

          {editingMsg ? (
            <div
              onClick={() => setEditingMsg(null)}
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.25)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 16,
                zIndex: 10000,
              }}
            >
              <div
                onClick={(e) => e.stopPropagation()}
                style={{
                  width: "min(640px, 100%)",
                  borderRadius: 16,
                  border: "1px solid #eee",
                  background: "white",
                  padding: 14,
                  boxShadow: "0 10px 30px rgba(0,0,0,0.15)",
                }}
              >
                <div style={{ fontWeight: 700, marginBottom: 10 }}>Edit message</div>

                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  rows={4}
                  style={{
                    width: "100%",
                    padding: 12,
                    borderRadius: 12,
                    border: "1px solid #ddd",
                    resize: "vertical",
                  }}
                />

                <div style={{ display: "flex", gap: 8, marginTop: 10, justifyContent: "flex-end" }}>
                  <button
                    style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd" }}
                    onClick={() => setEditingMsg(null)}
                  >
                    Cancel
                  </button>

                  <button
                    style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd" }}
                    onClick={async () => {
                      try {
                        await editMessage(editingMsg, editText);
                        setEditingMsg(null);
                      } catch (e) {
                        alert(e?.message || "Edit failed");
                      }
                    }}
                  >
                    Save
                  </button>
                </div>
              </div>
            </div>
          ) : null}

        </div>

        {viewer ? (
          <div
            onClick={() => setViewer(null)}
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,0.7)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16,
              zIndex: 20000,
            }}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                width: "min(960px, 100%)",
                maxHeight: "90vh",
                background: "black",
                borderRadius: 16,
                overflow: "hidden",
                position: "relative",
                border: "1px solid rgba(255,255,255,0.15)",
              }}
            >
              {/* Close button */}
              <button
                onClick={() => setViewer(null)}
                style={{
                  position: "absolute",
                  top: 10,
                  right: 10,
                  width: 38,
                  height: 38,
                  borderRadius: 999,
                  border: "1px solid rgba(255,255,255,0.25)",
                  background: "rgba(0,0,0,0.5)",
                  color: "white",
                  fontSize: 18,
                  cursor: "pointer",
                }}
                aria-label="Close"
              >
                ✕
              </button>

              {/* Optional title */}
              {viewer.title ? (
                <div style={{ position: "absolute", left: 12, top: 12, color: "white", opacity: 0.85, fontSize: 13 }}>
                  {viewer.title}
                </div>
              ) : null}

              <div style={{ paddingTop: 48, paddingBottom: 12, paddingLeft: 12, paddingRight: 12 }}>
                {viewer.kind === "image" ? (
                  <img
                    src={viewer.src}
                    alt={viewer.title || "image"}
                    style={{
                      width: "100%",
                      maxHeight: "80vh",
                      objectFit: "contain",
                      display: "block",
                      borderRadius: 12,
                      background: "black",
                    }}
                  />
                ) : (
                  <video
                    src={viewer.src}
                    controls
                    autoPlay
                    style={{
                      width: "100%",
                      maxHeight: "80vh",
                      display: "block",
                      borderRadius: 12,
                      background: "black",
                    }}
                  />
                )}
              </div>
            </div>
          </div>
        ) : null}


        {/* selection mode */}
        {selectMode ? (
          <>
            {/* Left rail (the vertical part of the L) */}
            <div style={{
              position: "fixed",
              left: 16,
              top: 92,
              bottom: 92,
              width: 6,
              borderRadius: 999,
              background: "rgba(17,17,17,0.08)",
              zIndex: 9000,
            }} />

            {/* Bottom action bar (the horizontal part of the L) */}
            <div style={{
              position: "fixed",
              left: 16,
              right: 16,
              bottom: 16,
              zIndex: 9001,
              background: "white",
              border: "1px solid #eee",
              borderRadius: 16,
              padding: 12,
              boxShadow: "0 10px 30px rgba(0,0,0,0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 10,
            }}>
              <div style={{ fontSize: 13, opacity: 0.8 }}>
                {selectedIds.size} selected
              </div>

              <div style={{ display: "flex", gap: 8 }}>
                <button
                  onClick={exitSelectMode}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
                >
                  Cancel
                </button>

                <button
                  disabled={selectedIds.size === 0}
                  onClick={bulkStar}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
                >
                  ⭐ Star
                </button>

                <button
                  disabled={selectedIds.size === 0}
                  onClick={bulkDelete}
                  style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
                >
                  🗑️ Delete
                </button>
              </div>
            </div>
          </>
        ) : null}



        {call?.active && !callOverlayHidden ? (
          <div
            style={{
              position: "fixed",
              right: 16,
              bottom: 16,
              width: 320,
              borderRadius: 16,
              border: "1px solid #eee",
              background: "white",
              padding: 12,
              zIndex: 9999,
            }}
          >
            <div style={{ fontWeight: 800 }}>📹 Group call</div>

            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              Host: {call.host || "(unknown)"}
            </div>

            <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
              {(call.participants || []).slice(0, 6).join(", ")}
              {(call.participants || []).length > 6 ? "…" : ""}
            </div>

            <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
              {!inCall ? (
                <>
                  <button
                    onClick={async () => {
                      // ensure roomId is set in context (important)
                      setRoomId(roomIDNum);

                      await joinCall(); // gets media + sends call_join
                      navigate(`/call/${roomIDNum}`);
                    }}
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      cursor: "pointer",
                    }}
                  >
                    Join Call
                  </button>

                  <button
                    onClick={() => setCallOverlayHidden(true)}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      cursor: "pointer",
                    }}
                  >
                    Dismiss
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => navigate(`/call/${roomIDNum}`)}
                    style={{
                      flex: 1,
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      cursor: "pointer",
                    }}
                  >
                    Open Call
                  </button>

                  <button
                    onClick={() => setCallOverlayHidden(true)}
                    style={{
                      padding: "10px 12px",
                      borderRadius: 12,
                      border: "1px solid #ddd",
                      cursor: "pointer",
                    }}
                  >
                    Dismiss
                  </button>
                </>
              )}
            </div>
          </div>
        ) : null}



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
                {users.map((u, i) => (
                  <div
                    key={`${u.email}_${i}`}
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
