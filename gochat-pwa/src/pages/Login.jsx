import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { setToken } from "../api/auth";
import { http } from "../api/http";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  async function doRegister(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const res = await http("/auth/register", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const token = res?.token;
      if (!token) throw new Error("register succeeded but no token returned");
      setToken(token);
      localStorage.setItem("gochat_token", token);
      navigate("/rooms");
    } catch (e) {
      setErr(e?.message || "Register failed");
    } finally {
      setLoading(false);
    }
  }

  async function onLogin(e) {
    e.preventDefault();
    setErr("");
    setLoading(true);
    try {
      const data = await http("/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      const token = data?.token;
      if (!token) throw new Error("login succeeded but no token returned");
      setToken(token);
      localStorage.setItem("gochat_token", token);
      navigate("/rooms");
    } catch (e) {
      setErr(e?.message || "Login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ maxWidth: 420, margin: "60px auto", padding: 16 }}>
      <h2 style={{ marginBottom: 8 }}>GoChat</h2>

      <form onSubmit={onLogin} style={{ display: "grid", gap: 10 }}>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd" }}
        />
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password (min 8 chars)"
          type="password"
          autoComplete="current-password"
          style={{ padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd" }}
        />

        {err ? <div style={{ color: "crimson" }}>{err}</div> : null}

        <div style={{ display: "flex", gap: 8 }}>
          <button
            type="button"
            onClick={doRegister}
            disabled={loading}
            style={{ flex: 1, padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
          >
            {loading ? "..." : "Register"}
          </button>

          <button
            type="submit"
            disabled={loading}
            style={{ flex: 1, padding: "12px 14px", borderRadius: 12, border: "1px solid #ddd", cursor: "pointer" }}
          >
            {loading ? "..." : "Login"}
          </button>
        </div>
      </form>
    </div>
  );
}
