import { createContext, useContext, useEffect, useMemo, useRef, useCallback, useState } from "react";

function connectWS() {
    const API_BASE = import.meta.env.VITE_API_BASE || "http://localhost:8080";
    const token = localStorage.getItem("gochat_token") || "";

    const wsBase = API_BASE.replace(/^http/, "ws");
    const url = `${wsBase}/ws?token=${encodeURIComponent(token)}`;

    console.log("[WS] connectWS url =", url); // ✅ add this

    return new WebSocket(url);
}

const WSContext = createContext(null);

export function WSProvider({ children }) {
    const wsRef = useRef(null);
    const queueRef = useRef([]); // queued JSON strings
    const [isOpen, setIsOpen] = useState(false);

    const flushQueue = useCallback(() => {
        const ws = wsRef.current;
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        while (queueRef.current.length) {
            ws.send(queueRef.current.shift());
        }
    }, []);

    const wsSend = useCallback((obj) => {
        const ws = wsRef.current;
        const payload = JSON.stringify(obj);

        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
            return true;
        }

        // ✅ queue until open
        queueRef.current.push(payload);
        console.warn("[WS] queued (not open yet)", obj);
        return true;
    }, []);

    useEffect(() => {
        let cancelled = false;
        let timer = null;

        const tryConnect = () => {
            if (cancelled) return;

            const token = localStorage.getItem("gochat_token") || "";
            if (!token) {
                timer = setTimeout(tryConnect, 250);
                return;
            }

            const existing = wsRef.current;
            if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
                return;
            }

            console.log("[WS] attempting connect", {
                hasToken: !!(localStorage.getItem("gochat_token") || ""),
                existing: wsRef.current ? wsRef.current.readyState : null,
            });

            const ws = connectWS();
            wsRef.current = ws;

            ws.onopen = () => {
                console.log("[WS] open");
                setIsOpen(true);
                flushQueue();
            };

            ws.onclose = (e) => {
                console.log("[WS] close", { code: e.code, reason: e.reason, wasClean: e.wasClean });
                setIsOpen(false);
                wsRef.current = null;
                if (!cancelled) timer = setTimeout(tryConnect, 500);
            };

            ws.onerror = (e) => {
                console.log("[WS] error", e);
                // ensure we can retry
                try { ws.close(); } catch { }
            };

            ws.onmessage = (evt) => {
                // IMPORTANT: don’t set per-page ws.onmessage.
                // Pages should use wsRef.current.addEventListener("message", ...)
            };
        };

        tryConnect();

        return () => {
            cancelled = true;
            if (timer) clearTimeout(timer);
            try { wsRef.current?.close(); } catch { }
            wsRef.current = null;
            setIsOpen(false);
        };
    }, [flushQueue]);

    const value = useMemo(() => ({ wsRef, wsSend, isOpen }), [wsSend, isOpen]);

    return <WSContext.Provider value={value}>{children}</WSContext.Provider>;
}

export function useWS() {
    const ctx = useContext(WSContext);
    if (!ctx) throw new Error("useWS must be used within <WSProvider>");
    return ctx;
}
