import React, {
    createContext, useCallback, useContext, useEffect, useMemo, useRef, useState
} from "react";
import { useWS } from "./WSContext";

const CallContext = createContext(null);

export function CallProvider({ children }) {
    const meRef = useRef(null);
    const roomIdRef = useRef(null);
    // --- WebRTC offer de-dupe ---
    const offeredRef = useRef(new Set()); // key: `${meNow}->${peerEmail}`

    const [localStream, setLocalStream] = useState(null);
    const [meEmail, setMeEmail] = useState(null);

    const [callState, setCallState] = useState(null);

    const peersRef = useRef(new Map());
    const [remotePeers, setRemotePeers] = useState([]);
    const localStreamRef = useRef(null);
    const ctxIdRef = useRef(Math.random().toString(16).slice(2));

    // ✅ wsRef is defined HERE (inside provider)
    const { wsRef, wsSend, isOpen } = useWS();

    const screenStreamRef = useRef(null);     // MediaStream from getDisplayMedia
    const [screenStream, setScreenStream] = useState(null); // optional (for local preview)


    const syncRemotePeers = useCallback(() => {
        const arr = Array.from(peersRef.current.entries()).map(([email, obj]) => ({
            email,
            hasStream: !!obj.stream,
            trackCount: obj.stream?.getTracks?.().length || 0,
        }));

        console.log("[CallContext] syncRemotePeers", arr);
        setRemotePeers(arr.map(x => ({ email: x.email, stream: peersRef.current.get(x.email)?.stream || null })));
    }, []);


    const addLocalTracksToPC = useCallback((pc) => {
        const stream = localStreamRef.current;
        if (!stream) return;

        const senders = pc.getSenders ? pc.getSenders() : [];
        for (const track of stream.getTracks()) {
            const hasKind = senders.some((s) => s.track && s.track.kind === track.kind);
            if (!hasKind) pc.addTrack(track, stream);
        }
    }, []);


    const addLocalTracksToAllPCs = useCallback(() => {
        const stream = localStreamRef.current;
        if (!stream) return;

        for (const [, obj] of peersRef.current.entries()) {
            if (obj?.pc) addLocalTracksToPC(obj.pc);
        }
    }, [addLocalTracksToPC]);


    // ---------- Offer tie-breaker ----------
    function shouldOfferTo(peerEmail, call) {
        const meNow = meRef.current?.email || meEmail;
        if (!meNow) return false;
        if (!call?.host) return false;

        // ✅ non-host initiates offers (joiner offers)
        if (call.host !== meNow) return true;

        // host does not initiate
        return false;
    }


    const RTC_CFG = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

    const getOrCreatePC = useCallback((peerEmail) => {
        const meNow = meRef.current?.email || meEmail;
        if (meNow && peerEmail === meNow) return null; // never create PC for self

        const entry = peersRef.current.get(peerEmail);
        if (entry?.pc) return entry.pc;

        console.log("[webrtc] create PC for", peerEmail);

        const pc = new RTCPeerConnection(RTC_CFG);

        // Create a stream holder up-front (robust)
        const remoteStream = new MediaStream();
        peersRef.current.set(peerEmail, { pc, stream: remoteStream });
        syncRemotePeers(); // shows placeholder tile immediately

        pc.onicecandidate = (event) => {
            if (!event.candidate) return;
            console.log("[webrtc] ICE ->", peerEmail);

            wsSend({
                type: "webrtc_ice",
                roomId: Number(roomIdRef.current),
                to: peerEmail,
                ice: event.candidate,
            });
        };

        pc.ontrack = (event) => {
            console.log("[webrtc] ontrack from", peerEmail, event.track.kind);

            const obj = peersRef.current.get(peerEmail);
            if (!obj) return;

            const stream = obj.stream; // you already created it up-front

            // ✅ prevent duplicates
            const already = stream.getTracks().some((t) => t.id === event.track.id);
            if (!already) stream.addTrack(event.track);

            // ✅ optional: remove when track ends
            event.track.onended = () => {
                try { stream.removeTrack(event.track); } catch { }
                syncRemotePeers();
            };

            syncRemotePeers();
        };

        pc.onconnectionstatechange = () => {
            const st = pc.connectionState;
            console.log("[webrtc] pc state", peerEmail, st);

            if (st === "failed" || st === "closed" || st === "disconnected") {
                peersRef.current.delete(peerEmail);
                syncRemotePeers();
            }
        };

        return pc;
    }, [meEmail, syncRemotePeers, wsSend]);


    async function renegotiateToPeer(peerEmail) {
        const obj = peersRef.current.get(peerEmail);
        const pc = obj?.pc;
        if (!pc) return;

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        wsSend({
            type: "webrtc_offer",
            roomId: Number(roomIdRef.current),
            to: peerEmail,
            sdp: pc.localDescription,
        });

        console.log("[share] renegotiation offer ->", peerEmail);
    }


    // ---------- Media ----------
    const ensureLocalMedia = useCallback(async () => {
        if (localStreamRef.current) return localStreamRef.current;

        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        localStreamRef.current = stream;
        setLocalStream(stream);

        // add tracks to all PCs
        for (const [email, obj] of peersRef.current.entries()) {
            if (obj?.pc) addLocalTracksToPC(obj.pc);
        }

        // ✅ renegotiate so peers actually receive host video
        for (const email of peersRef.current.keys()) {
            renegotiateToPeer(email).catch((e) => console.warn("[webrtc] renegotiate failed", email, e));
        }

        return stream;
    }, [addLocalTracksToPC, renegotiateToPeer]);



    const stopLocalMedia = useCallback(() => {
        const s = localStreamRef.current;
        if (!s) return;
        s.getTracks().forEach(t => t.stop());
        localStreamRef.current = null;
        setLocalStream(null);
    }, []);


    async function makeOffer(toEmail) {
        console.log("[webrtc] makeOffer ->", toEmail);

        const pc = getOrCreatePC(toEmail);
        if (!pc) return;

        // ✅ If we already have local tracks, add them
        if (localStreamRef.current) {
            addLocalTracksToPC(pc);
        } else {
            // ✅ View-only mode: still ask to receive audio/video
            try {
                pc.addTransceiver("video", { direction: "recvonly" });
                pc.addTransceiver("audio", { direction: "recvonly" });
            } catch (e) {
                console.warn("[webrtc] addTransceiver failed (ok)", e);
            }
        }

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        const ok = wsSend({
            type: "webrtc_offer",
            roomId: Number(roomIdRef.current),
            to: toEmail,
            sdp: pc.localDescription,
        });

        console.log("[webrtc] SENT offer ->", toEmail, "wsSendOk?", ok);
    }


    async function handleOffer(fromEmail, sdp) {
        console.log("[webrtc] RX offer <-", fromEmail);

        const pc = getOrCreatePC(fromEmail);
        if (!pc) return;

        await pc.setRemoteDescription(new RTCSessionDescription(sdp));

        // ✅ IMPORTANT: add tracks BEFORE answering (so answer SDP includes your video/audio)
        if (localStreamRef.current) {
            addLocalTracksToPC(pc);
        } else {
            console.warn("[webrtc] no localStream yet; answering view-only (host video will be missing until renegotiation)");
        }

        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);

        const ok = wsSend({
            type: "webrtc_answer",
            roomId: Number(roomIdRef.current),
            to: fromEmail,
            sdp: pc.localDescription,
        });

        console.log("[webrtc] SENT answer ->", fromEmail, "wsSendOk?", ok);
    }


    async function handleAnswer(fromEmail, sdp) {
        console.log("[webrtc] handleAnswer <-", fromEmail);
        const pc = getOrCreatePC(fromEmail);
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    }


    async function handleIce(fromEmail, ice) {
        const pc = getOrCreatePC(fromEmail);
        try {
            await pc.addIceCandidate(new RTCIceCandidate(ice));
        } catch (e) {
            console.warn("[webrtc] addIceCandidate failed", e);
        }
    }


    async function replaceVideoTrackForAll(newVideoTrack) {
        for (const [, obj] of peersRef.current.entries()) {
            const pc = obj?.pc;
            if (!pc) continue;

            const sender = pc.getSenders().find((s) => s.track?.kind === "video");
            if (sender) {
                await sender.replaceTrack(newVideoTrack);
            } else {
                pc.addTrack(newVideoTrack, new MediaStream([newVideoTrack]));
            }
        }
        console.log("[share] replaced outgoing video track for all peers");
    }


    const startScreenShare = useCallback(async () => {
        const rid = Number(roomIdRef.current);
        if (!Number.isFinite(rid) || rid <= 0) return;

        // ask browser for screen
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: true,
            audio: false, // start simple; can add later
        });

        screenStreamRef.current = stream;
        setScreenStream(stream);

        const [screenTrack] = stream.getVideoTracks();
        if (!screenTrack) return;

        // If user stops sharing via browser UI, cleanup
        screenTrack.onended = () => {
            stopScreenShare().catch(() => { });
        };

        // send screen video to everyone
        await replaceVideoTrackForAll(screenTrack);

        // ✅ force peers to re-evaluate the stream
        for (const email of peersRef.current.keys()) {
            await renegotiateToPeer(email);
        }

        // tell server who is sharing so everyone stages it
        wsSend({ type: "call_share_start", roomId: rid });

        console.log("[share] started");
    }, [replaceVideoTrackForAll, wsSend]);


    const stopScreenShare = useCallback(async () => {
        const rid = Number(roomIdRef.current);

        const s = screenStreamRef.current;
        if (s) {
            s.getTracks().forEach(t => t.stop());
        }
        screenStreamRef.current = null;
        setScreenStream(null);

        // revert to camera if you have it
        const cam = localStreamRef.current;
        const camTrack = cam?.getVideoTracks?.()?.[0] || null;

        if (camTrack) {
            await replaceVideoTrackForAll(camTrack);
            console.log("[share] reverted to camera track");

            for (const email of peersRef.current.keys()) {
                await renegotiateToPeer(email);
            }
        } else {
            console.log("[share] no camera track to revert to (view-only)");
        }

        if (Number.isFinite(rid) && rid > 0) {
            wsSend({ type: "call_share_stop", roomId: rid });
        }
    }, [replaceVideoTrackForAll, wsSend]);


    // ---------- Cleanup ----------
    const cleanupCall = useCallback(() => {
        // Close PCs
        for (const { pc } of peersRef.current.values()) {
            try { pc.close(); } catch { }
        }
        peersRef.current.clear();
        syncRemotePeers();

        // Release camera/mic
        stopLocalMedia();
    }, [stopLocalMedia, syncRemotePeers]);

    // ---------- Connect to peers ----------
    const connectToPeers = useCallback(async (participants) => {
        await ensureLocalMedia();

        const meEmail = meRef.current?.email;
        if (!meEmail) return;

        for (const peerEmail of participants || []) {
            if (!peerEmail || peerEmail === meEmail) continue;

            const pc = getOrCreatePC(peerEmail);

            addLocalTracksToPC(pc);
            addLocalTracksToAllPCs();

            if (shouldOfferTo(peerEmail)) {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);

                wsSend({
                    type: "webrtc_offer",
                    roomId: roomIdRef.current,
                    to: peerEmail,
                    sdp: pc.localDescription,
                });
            }
        }
    }, [addLocalTracksToPC, addLocalTracksToAllPCs, ensureLocalMedia, getOrCreatePC, shouldOfferTo, wsSend]);

    // ---------- Public actions (used by Room/CallPage) ----------
    const setMe = useCallback((me) => {
        meRef.current = me;
        setMeEmail(me?.email || null);
    }, []);


    const setRoomId = useCallback((roomId) => {
        const rid = Number(roomId);
        roomIdRef.current = rid;

        // ✅ ensure this WS is subscribed to that room
        if (Number.isFinite(rid) && rid > 0) {
            wsSend({ type: "join_room", roomId: rid });
            wsSend({ type: "presence", roomId: rid, status: "active" });
            wsSend({ type: "call_sync", roomId: rid });
        }
    }, [wsSend]);


    const startCall = useCallback(() => {
        const rid = Number(roomIdRef.current);
        if (!Number.isFinite(rid) || rid <= 0) return;
        wsSend({ type: "call_start", roomId: rid });
    }, [wsSend]);


    const joinCall = useCallback(async () => {
        const rid = Number(roomIdRef.current);

        // Try to enable media, but don't block joining the call if denied
        try {
            await ensureLocalMedia();
        } catch (e) {
            console.warn("[call] join without local media:", e?.name, e?.message);
            // continue view-only
        }

        wsSend({ type: "call_join", roomId: rid });
        wsSend({ type: "call_sync", roomId: rid });
    }, [ensureLocalMedia, wsSend]);


    const leaveCall = useCallback(() => {
        const rid = Number(roomIdRef.current);
        if (!Number.isFinite(rid) || rid <= 0) {
            console.warn("[CallContext] leaveCall skipped; invalid roomId", roomIdRef.current);
            cleanupCall(); // still cleanup local resources
            return;
        }
        wsSend({ type: "call_leave", roomId: rid });
        cleanupCall();
    }, [cleanupCall, wsSend]);

    const endCall = useCallback(() => {
        const rid = Number(roomIdRef.current);
        if (!Number.isFinite(rid) || rid <= 0) {
            console.warn("[CallContext] endCall skipped; invalid roomId", roomIdRef.current);
            cleanupCall();
            return;
        }
        wsSend({ type: "call_end", roomId: rid });
        cleanupCall();
    }, [cleanupCall, wsSend]);

    const syncCall = useCallback((roomId) => {
        const rid = Number(roomId ?? roomIdRef.current);
        if (!Number.isFinite(rid) || rid <= 0) {
            console.warn("[CallContext] syncCall skipped; invalid roomId", { roomId, current: roomIdRef.current });
            return;
        }
        wsSend({ type: "call_sync", roomId: rid });
    }, [wsSend]);


    // ---------- WS listeners (shared WS from WSContext) ----------
    useEffect(() => {
        if (!isOpen) return;

        const ws = wsRef.current;
        if (!ws) return;

        const onMessage = async (evt) => {
            let data;
            try { data = JSON.parse(evt.data); } catch { return; }

            // If we haven't set roomId yet, adopt it from the first message we care about
            const incomingRoomId = Number(data.roomId);
            if (!Number.isFinite(Number(roomIdRef.current)) || Number(roomIdRef.current) <= 0) {
                if (Number.isFinite(incomingRoomId) && incomingRoomId > 0) roomIdRef.current = incomingRoomId;
            }

            if (data.type?.startsWith("webrtc")) {
                console.log("[CallContext] RX webrtc raw", data);
            }


            const rid = Number(roomIdRef.current);
            if (!Number.isFinite(rid) || rid <= 0) return;
            if (incomingRoomId !== rid) return;

            const meNow = meRef.current?.email || meEmail;

            // helper: ignore targeted messages not meant for me
            const shouldIgnoreTargeted = (to) => to && meNow && to !== meNow;

            // ---------------- call_state ----------------
            if (data.type === "call_state") {
                const call = data.call ? { ...data.call } : null;
                if (call && !Array.isArray(call.participants)) call.participants = [];
                setCallState(call);

                if (!call?.active) {
                    offeredRef.current.clear();     // ✅ reset offer guard
                    cleanupCall();
                    return;
                }

                if (!meNow) return;

                const participants = call.participants || [];
                const others = participants.filter((e) => e && e !== meNow);

                console.log("[webrtc] offerFlags:", others.map((peer) => ({
                    meNow,
                    peer,
                    willOffer: shouldOfferTo(peer, call),
                })));

                // placeholders
                for (const email of others) getOrCreatePC(email);

                // offer decision
                for (const email of others) {
                    if (!shouldOfferTo(email, call)) continue;

                    const key = `${meNow}->${email}`;
                    if (offeredRef.current.has(key)) continue;
                    offeredRef.current.add(key);

                    try {
                        console.log("[webrtc] calling makeOffer", email);
                        await makeOffer(email);
                        console.log("[webrtc] makeOffer done", email);
                    } catch (e) {
                        console.warn("[webrtc] makeOffer crashed", e);
                        offeredRef.current.delete(key); // ✅ allow retry if it failed
                    }
                }

                return;
            }


            // ---------------- signaling messages ----------------
            const from = data.from || data.userEmail || data.sender || data.email;
            const to = data.to;

            // if (shouldIgnoreTargeted(to)) return;
            // if (from && meNow && from === meNow) return; 

            if (to && meNow && to !== meNow) {
                console.log("[CallContext] DROPPED targeted", { type: data.type, to, meNow, from });
                return;
            }
            // ignore not for me
            if (from && meNow && from === meNow) return;  // ignore echo

            if (data.type === "webrtc_offer") {
                if (!from) return;
                await handleOffer(from, data.sdp);
                return;
            }

            if (data.type === "webrtc_answer") {
                if (!from) return;
                await handleAnswer(from, data.sdp);
                return;
            }

            if (data.type === "webrtc_ice") {
                if (!from) return;
                if (data.ice) await handleIce(from, data.ice);
                return;
            }
        };

        ws.addEventListener("message", onMessage);
        return () => ws.removeEventListener("message", onMessage);
    }, [isOpen, wsRef, meEmail, wsSend, cleanupCall, getOrCreatePC, makeOffer, handleOffer, handleAnswer, handleIce, shouldOfferTo]);


    const value = useMemo(() => ({
        // state
        callState,
        ctxId: ctxIdRef.current,
        remotePeers,
        meEmail,
        localStream,

        // setup
        setMe,
        setRoomId,

        // actions
        startCall,
        joinCall,
        leaveCall,
        endCall,
        syncCall,

        // optional exports if you need them
        wsSend,
        cleanupCall,
        ensureLocalMedia,
        stopLocalMedia,
        startScreenShare,
        stopScreenShare,
        screenStream,
    }), [
        callState,
        remotePeers,
        meEmail,
        localStream,
        screenStream,
        setMe,
        setRoomId,
        startCall,
        joinCall,
        leaveCall,
        endCall,
        syncCall,
        ensureLocalMedia,
        stopLocalMedia,
        startScreenShare,
        stopScreenShare,
        wsSend,
        cleanupCall,
    ]);


    return <CallContext.Provider value={value}>{children}</CallContext.Provider>;
}

export function useCall() {
    const ctx = useContext(CallContext);
    if (!ctx) throw new Error("useCall must be used within <CallProvider>");
    return ctx;
}

