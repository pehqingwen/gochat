import { Routes, Route, Navigate } from "react-router-dom";
import Login from "./pages/Login.jsx";
import Rooms from "./pages/Rooms.jsx";
import Room from "./pages/Room.jsx";
import Starred from "./pages/Starred.jsx";
import CallPage from "./pages/CallPage";
import { CallProvider } from "./contexts/CallContext";
import { WSProvider } from "./contexts/WSContext";

export default function App() {
  return (
    <WSProvider>
      <CallProvider>
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/rooms" element={<Rooms />} />
          <Route path="/rooms/:roomId" element={<Room />} />
          <Route path="/starred" element={<Starred />} />
          <Route path="/call/:roomId" element={<CallPage />} />
          <Route path="/" element={<Navigate to="/rooms" replace />} />
          <Route path="*" element={<Navigate to="/rooms" replace />} />
        </Routes>
      </CallProvider>
    </WSProvider>
  );
}

// BACKEND only 
// windows + . will have emoticons picker 
// IGNORE TINY BUGS! 
// send .gifs and stickers 
// event rsvp thing 

// refresh should stay connected in call 
// buttons? 
// screen sharing *****
// call logs (last)

// consolidate all attach into one button "+" near msg input box
// indicator at scroll logo when new msgs arrive while not at bottom 
// remove "Load older messages" button -> affects starred ->0
// change to pagination on scroll upwards 

