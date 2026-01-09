import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login.jsx";
import Rooms from "./pages/Rooms.jsx";
import Room from "./pages/Room.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/rooms" element={<Rooms />} />
      <Route path="/rooms/:roomId" element={<Room />} />
      <Route path="/" element={<Navigate to="/rooms" replace />} />
      <Route path="*" element={<Navigate to="/rooms" replace />} />
    </Routes>
  );
}
