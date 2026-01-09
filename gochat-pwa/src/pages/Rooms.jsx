import { useEffect, useState } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { clearToken, getToken } from "../api/auth";
import { http } from "../api/http";

export default function Rooms() {
  const navigate = useNavigate();

  // --- UI state (hooks must always be called) ---
  const [checking, setChecking] = useState(true);
  const [authed, setAuthed] = useState(() => !!getToken());
  const [me, setMe] = useState(null);

  const [rooms, setRooms] = useState([]); // rooms from DB
  const [name, setName] = useState("");

  // page selector
  const [page, setPage] = useState("default"); // "default" | "mine"

  // default rooms (not from DB)
  const defaultRooms = [
    { id: "general", name: "General" },
    { id: "random", name: "Random" },
  ];

  // rooms created by user (from DB)
  const myRooms = rooms.filter((r) => r.is_owner);
  const joinedRooms = rooms.filter((r) => !r.is_owner);

  const listToShow =
    page === "default" ? defaultRooms :
      page === "mine" ? myRooms :
        joinedRooms;

  useEffect(() => {
    const token = getToken();
    if (!token) {
      setAuthed(false);
      setChecking(false);
      return;
    }

    (async () => {
      try {
        const info = await http("/me");
        setMe(info);
        setAuthed(true);

        // load rooms from DB
        const list = await http("/rooms");
        setRooms(Array.isArray(list) ? list : []);
      } catch (e) {
        clearToken();
        setMe(null);
        setAuthed(false);
      } finally {
        setChecking(false);
      }
    })();
  }, []);

  async function refreshRooms() {
    const list = await http("/rooms");
    setRooms(Array.isArray(list) ? list : []);
  }

  async function createRoom(e) {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;

    try {
      await http("/rooms", {
        method: "POST",
        body: JSON.stringify({ name: n }),
      });
      setName("");
      await refreshRooms();
      setPage("mine"); // switch to My Rooms so user sees what they created
    } catch (e2) {
      alert(e2.message || "Failed to create room");
    }
  }

  async function joinRoomPrompt() {
    const input = window.prompt("Enter invited room ID (e.g. 1, 2, 3):");
    if (input == null) return; // user cancelled

    const roomId = Number(String(input).trim());
    if (!Number.isInteger(roomId) || roomId <= 0) {
      alert("Please enter a valid numeric room ID.");
      return;
    }

    try {
      await http(`/rooms/${roomId}/join`, { method: "POST" });
      await refreshRooms(); // you already have this helper in the full Rooms.jsx I sent
      setPage("joined");
      // optional: navigate straight into the room
      // navigate(`/rooms/${roomId}`);
    } catch (e) {
      alert(e.message || "Failed to join room");
    }
  }

  function logout() {
    clearToken();
    setAuthed(false);
    setMe(null);
    navigate("/login");
  }

  // --- render guards (after hooks) ---
  if (!authed) return <Navigate to="/login" replace />;
  if (checking) return <div style={{ padding: 16 }}>Checking session…</div>;

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", padding: 16 }}>
      {/* Header */}
      <div style={{ display: "flex", gap: 8, justifyContent: "space-between", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Rooms</h2>
          <div style={{ fontSize: 12, opacity: 0.75 }}>
            Logged in as {me?.email || "(unknown)"}
          </div>
        </div>

        <button
          onClick={joinRoomPrompt}
          style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
        >
          Join Room
        </button>

        <button
          onClick={logout}
          style={{ padding: "10px 12px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
        >
          Logout
        </button>
      </div>

      {/* Create room */}
      <form onSubmit={createRoom} style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Create a room (e.g. Project Team)"
          style={{ flex: 1, padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd" }}
        />
        <button
          type="submit"
          style={{ padding: "12px 16px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
        >
          Create
        </button>
      </form>

      {/* Rooms list */}
      <div style={{ marginTop: 16, display: "grid", gap: 10 }}>
        {listToShow.length === 0 ? (
          <div style={{ opacity: 0.7 }}>
            {page === "mine" ? "You haven't created any rooms yet." : "No rooms."}
          </div>
        ) : (
          listToShow.map((r) => (
            <div
              key={r.id}
              style={{
                padding: 14,
                borderRadius: 14,
                border: "1px solid #eee",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 10,
              }}
            >
              <Link
                to={`/rooms/${r.id}`}
                style={{ textDecoration: "none", color: "inherit", flex: 1 }}
              >
                <div style={{ fontWeight: 600 }}>{r.name}</div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>Room ID: {r.id}</div>
              </Link>

              {/* Delete only for DB rooms created by user */}
              {page === "mine" && r.is_owner ? (
                <button
                  onClick={async () => {
                    if (!confirm(`Delete room "${r.name}"?`)) return;
                    await http(`/rooms/${r.id}`, { method: "DELETE" });
                    await refreshRooms();
                  }}
                  style={{
                    padding: "8px 10px",
                    borderRadius: 10,
                    border: "1px solid #ddd",
                    cursor: "pointer",
                  }}
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))
        )}
      </div>

      {/* Page selector BELOW the list */}
      <div style={{ marginTop: 14, display: "flex", gap: 8 }}>
        <button
          onClick={() => setPage("default")}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #ddd",
            cursor: "pointer",
            opacity: page === "default" ? 1 : 0.6,
            fontWeight: page === "default" ? 700 : 500,
          }}
        >
          Default Rooms
        </button>

        <button
          onClick={() => setPage("mine")}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #ddd",
            cursor: "pointer",
            opacity: page === "mine" ? 1 : 0.6,
            fontWeight: page === "mine" ? 700 : 500,
          }}
        >
          My Rooms
        </button>

        <button
          onClick={() => setPage("joined")}
          style={{
            flex: 1,
            padding: "10px 12px",
            borderRadius: 12,
            border: "1px solid #ddd",
            cursor: "pointer",
            opacity: page === "joined" ? 1 : 0.6,
            fontWeight: page === "joined" ? 700 : 500,
          }}
        >
          Joined Rooms
        </button>
      </div>
    </div>
  );
}
