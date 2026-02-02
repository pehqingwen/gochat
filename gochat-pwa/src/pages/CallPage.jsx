import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useCall } from "../contexts/CallContext";

export default function CallPage() {
  const navigate = useNavigate();
  const { roomId } = useParams();
  const roomIDNum = Number(roomId);

  const {
    ctxId,
    remotePeers,
    callState,
    meEmail,
    setRoomId,
    syncCall,
    joinCall,
    leaveCall,
    endCall,
    ensureLocalMedia,
    stopLocalMedia,
    // Recommended: expose localStream from CallContext (see notes below)
    localStream,
    startScreenShare,
    stopScreenShare,
    screenStream, // optional if you use it for local preview
  } = useCall();

  console.log("[CallPage render] callState =", callState);

  useEffect(() => {
    console.log("[CallPage] ctxId:", ctxId, "meEmail:", meEmail, "remotePeers:", remotePeers?.length, "callState:", callState);
  }, [ctxId, meEmail, remotePeers, callState]);

  // Host check (for End Call button)
  const isHost = !!callState?.host && !!meEmail && callState.host === meEmail;

  // “In call” check (for UI states)
  const inCall = useMemo(() => {
    if (!callState?.active || !meEmail) return false;
    return (callState.participants || []).includes(meEmail);
  }, [callState?.active, callState?.participants, meEmail]);

  // Local preview video element
  const localVideoRef = useRef(null);
  const [pinnedEmail, setPinnedEmail] = useState(null);

  const hostEmail = callState?.host || null;
  // ✅ define these BEFORE stage useMemo
  const screenOn = !!callState?.screenSharing;
  const screenSharer = callState?.screenSharer || null;
  const isHostMe = hostEmail && meEmail && hostEmail === meEmail;
  const isSharerMe = screenOn && screenSharer && meEmail && screenSharer === meEmail;

  // Helper: find a peer by email
  const findPeer = (email) => remotePeers.find((p) => p.email === email);

  // ✅ Stage: screen sharer wins; otherwise host
  const stage = useMemo(() => {
    // 1) Screen share takes over the stage
    if (screenOn && screenSharer) {
      if (isSharerMe) {
        // If I'm the sharer, stage my local screenStream (from getDisplayMedia)
        return { email: screenSharer, stream: screenStream, isLocal: true, mode: "screen" };
      }

      // Otherwise stage the sharer's remote stream
      const sharerPeer = findPeer(screenSharer);
      return sharerPeer
        ? { email: sharerPeer.email, stream: sharerPeer.stream, isLocal: false, mode: "screen" }
        : { email: screenSharer, stream: null, isLocal: false, mode: "screen" };
    }

    // 2) Otherwise stage host camera
    if (!hostEmail) return null;

    if (isHostMe) {
      return { email: meEmail, stream: localStream, isLocal: true, mode: "camera" };
    }

    const hostPeer = findPeer(hostEmail);
    return hostPeer
      ? { email: hostPeer.email, stream: hostPeer.stream, isLocal: false, mode: "camera" }
      : { email: hostEmail, stream: null, isLocal: false, mode: "camera" };
  }, [
    screenOn,
    screenSharer,
    isSharerMe,
    screenStream,
    hostEmail,
    isHostMe,
    meEmail,
    localStream,
    remotePeers,
  ]);

  // ✅ Then compute trackSig
  const stageTrackSig = stage?.stream
    ? stage.stream.getTracks().map(t => `${t.kind}:${t.id}`).join("|")
    : "";

  const sidebarPeers = (() => {
    const stageEmail = stage?.email;

    // Include:
    // - you as a tile if you're not already stage
    // - all remote peers except stage
    const tiles = [];

    if (meEmail && meEmail !== stageEmail) {
      tiles.push({ email: meEmail, stream: localStream, isLocal: true });
    }

    for (const p of remotePeers) {
      if (p.email === stageEmail) continue;
      tiles.push({ email: p.email, stream: p.stream, isLocal: false });
    }

    return tiles;
  })();


  // pick stage: pinned > host > first remote > local
  const stagePeer = useMemo(() => {
    const pinned = pinnedEmail ? remotePeers.find(p => p.email === pinnedEmail) : null;
    if (pinned?.stream) return { email: pinned.email, stream: pinned.stream, kind: "remote" };

    const hostPeer = hostEmail ? remotePeers.find(p => p.email === hostEmail) : null;
    if (hostPeer?.stream) return { email: hostPeer.email, stream: hostPeer.stream, kind: "remote" };

    const firstRemote = remotePeers.find(p => p.stream);
    if (firstRemote) return { email: firstRemote.email, stream: firstRemote.stream, kind: "remote" };

    // fallback to local stream if no remote yet
    return { email: meEmail || "You", stream: localStream || null, kind: "local" };
  }, [remotePeers, pinnedEmail, hostEmail, meEmail, localStream]);

  useEffect(() => {
    // attach local stream to local video preview
    if (localVideoRef.current) {
      localVideoRef.current.srcObject = localStream || null;
    }
  }, [localStream]);


  // Tell context which room we’re in + ask for latest call state
  useEffect(() => {
    setRoomId(roomIDNum);
    syncCall(roomIDNum); // ✅ pass explicitly
  }, [roomIDNum, setRoomId, syncCall]);


  useEffect(() => {
    console.log("[CallPage] remotePeers changed:", remotePeers);
    console.log("[CallPage] count:", remotePeers?.length);
    console.log(
      "[CallPage] peers streams:",
      (remotePeers || []).map(p => ({
        email: p.email,
        hasStream: !!p.stream,
        tracks: p.stream ? p.stream.getTracks().map(t => `${t.kind}:${t.readyState}`) : [],
      }))
    );

    console.log(
      "host peer tracks:",
      remotePeers.find(p => p.email === callState?.host)?.stream?.getTracks()?.map(t => t.kind) || []
    );


  }, [remotePeers]);


  function goBackToRoom() {
    navigate(`/room/${roomIDNum}`);
  }

  function confirmLeaveAndExit() {
    if (!window.confirm("Confirm leaving group call?")) return;
    leaveCall();
    goBackToRoom();
  }

  async function handleJoin() {
    try {
      await joinCall(); // requests cam/mic and sends call_join
      // stay on this page
    } catch (e) {
      alert(e?.message || "Camera/mic error");
    }
  }

  return (
    <div style={{ padding: 14, maxWidth: 1100, margin: "0 auto", position: "relative" }}>
      {/* Top right X */}
      <button
        onClick={confirmLeaveAndExit}
        style={{
          position: "absolute",
          top: 12,
          right: 12,
          width: 36,
          height: 36,
          borderRadius: 10,
          cursor: "pointer",
          zIndex: 10,
          border: "1px solid #ddd",
          background: "white",
        }}
        aria-label="Leave call"
        title="Leave call"
      >
        ×
      </button>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
        <div>
          <div style={{ fontSize: 12, opacity: 0.7 }}>Room {roomIDNum}</div>
          <div style={{ fontSize: 18, fontWeight: 800 }}>Group call</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            {callState?.active ? (
              <>
                Host: {callState.host || "(unknown)"} · Participants: {(callState.participants || []).length}
              </>
            ) : (
              "No active call"
            )}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>

          <button
            onClick={() => startScreenShare().catch(e => alert(e?.message || "share failed"))}
            style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Share screen
          </button>

          <button
            onClick={() => stopScreenShare().catch(() => { })}
            style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
          >
            Stop share
          </button>


          {/* ✅ Camera/mic toggle (works for host and joiners) */}
          {localStream ? (
            <button
              onClick={stopLocalMedia}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
              title="Turn off your camera/mic"
            >
              Disable camera/mic
            </button>
          ) : (
            <button
              onClick={() => ensureLocalMedia().catch((e) => alert(e?.message || "camera/mic error"))}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
              title="Turn on your camera/mic"
            >
              Enable camera/mic
            </button>
          )}

          {/* Join/Leave */}
          {!inCall ? (
            <button
              onClick={handleJoin}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Join
            </button>
          ) : (
            <button
              onClick={confirmLeaveAndExit}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
            >
              Leave
            </button>
          )}

          {/* Host end */}
          {isHost ? (
            <button
              onClick={endCall}
              style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
              title="Only host can end the call"
            >
              End Call (host)
            </button>
          ) : null}
        </div>

      </div>


      {/* Zoom-like layout */}
      <div style={{ marginTop: 14, display: "grid", gridTemplateColumns: "1fr 260px", gap: 12, alignItems: "start" }}>
        {/* STAGE */}
        <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 10, background: "white" }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Stage: {stage?.email || "—"}{" "}
              {stage?.mode === "screen" ? "(screen)" : stage?.email === hostEmail ? "(host)" : ""}
            </div>
            <div style={{ fontSize: 12, opacity: 0.6 }}>
              {stage?.stream ? "Live" : "Waiting for video…"}
            </div>
          </div>

          <StageVideo
            email={stage?.email}
            stream={stage?.stream}
            trackSig={stageTrackSig}
            muted={true}   // start muted so Chrome will autoplay
          />

        </div>

        {/* SIDEBAR */}
        <div style={{ display: "grid", gap: 10 }}>
          {sidebarPeers.length === 0 ? (
            <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 10, opacity: 0.75 }}>
              No other participants yet
            </div>
          ) : (
            sidebarPeers.map((p) => {
              const trackSig = p.stream
                ? p.stream.getTracks().map(t => `${t.kind}:${t.id}`).join("|")
                : "";

              return (
                <SmallTile
                  key={p.email}
                  email={p.email}
                  stream={p.stream}
                  trackSig={trackSig}
                  muted={true} // keep muted for autoplay reliability
                />
              );
            })
          )}
        </div>
      </div>


    </div>
  );
}


function VideoBox({ stream, muted }) {
  const ref = useRef(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    v.srcObject = stream || null;

    // ✅ kick autoplay
    const p = v.play?.();
    if (p && typeof p.catch === "function") {
      p.catch((e) => console.warn("[video] play blocked:", e?.name, e?.message));
    }
  }, [stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={!!muted}        // ✅ important for Chrome autoplay
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}


function ThumbTile({ label, subLabel, stream, muted, onClick, isActive }) {
  return (
    <div
      onClick={onClick}
      style={{
        border: isActive ? "2px solid #3b82f6" : "1px solid #eee",
        borderRadius: 14,
        padding: 8,
        cursor: "pointer",
        background: "white",
      }}
      title="Click to pin to stage"
    >
      <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
        {label}
      </div>

      <VideoBox stream={stream} muted={muted} big={false} />

      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.65 }}>
        {subLabel || (stream ? "video on" : "video off")}
      </div>
    </div>
  );
}


function VideoEl({ stream, trackSig, muted }) {
  const ref = useRef(null);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;

    v.srcObject = stream || null;

    // Try to play immediately
    const p = v.play?.();
    if (p?.catch) p.catch((e) => console.warn("[video] play blocked:", e?.name, e?.message));
  }, [stream]);

  // ✅ Re-trigger play when tracks change (even if stream object is same)
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (!stream) return;

    const p = v.play?.();
    if (p?.catch) p.catch(() => { });
  }, [trackSig, stream]);

  return (
    <video
      ref={ref}
      autoPlay
      playsInline
      muted={!!muted}
      style={{ width: "100%", height: "100%", objectFit: "cover" }}
    />
  );
}

function StageVideo({ email, stream, trackSig, muted }) {
  return (
    <div style={{ width: "100%", aspectRatio: "16 / 9", background: "#000", borderRadius: 12, overflow: "hidden", position: "relative" }}>
      <VideoEl stream={stream} trackSig={trackSig} muted={muted} />
      <div style={{ position: "absolute", left: 10, bottom: 10, padding: "6px 8px", borderRadius: 10, background: "rgba(0,0,0,0.45)", color: "white", fontSize: 12 }}>
        {email || "—"}
      </div>
    </div>
  );
}

function SmallTile({ email, stream, trackSig, muted }) {
  return (
    <div style={{ border: "1px solid #ddd", borderRadius: 14, padding: 8, background: "white" }}>
      <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis" }}>
        {email}
      </div>
      <div style={{ width: "100%", aspectRatio: "16 / 9", background: "#000", borderRadius: 10, overflow: "hidden" }}>
        <VideoEl stream={stream} trackSig={trackSig} muted={muted} />
      </div>
      <div style={{ marginTop: 6, fontSize: 12, opacity: 0.7 }}>
        {stream ? `${stream.getTracks().length} track(s)` : "No stream yet"}
      </div>
    </div>
  );
}
