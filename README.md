# GoChat PWA (Go + WebSocket + Postgres)

A lightweight real-time group chat app built to showcase backend + realtime systems skills in Go.

**Tech stack**
- Backend: Go, chi router, JWT auth, WebSocket hub (rooms, presence)
- DB: Postgres
- Frontend: Vite + React (JavaScript) with a PWA-ready setup
- Uploads: HTTP upload endpoint + static `/uploads/*` (DB stores metadata, not file bytes)

---

## Features
- ✅ Email + password registration/login (JWT)
- ✅ Rooms (list/create/delete; join via room ID)
- ✅ Real-time messages via WebSocket
- ✅ Typing indicators
- ✅ Presence + idle/away status (active → idle after inactivity)
- ✅ File uploads (PDF/images): upload via HTTP, share via chat message (other users can download)
- ✅ Message history persisted in Postgres (includes attachment metadata)
  
🚀 Feature added: Room Video Call — real-time group video calling inside each chat room (WebRTC), including screen sharing support.

---

## Getting started (local)

### 1) Prereqs
- Go installed
- Docker Desktop installed (for Postgres)
- Node.js installed (for frontend)

### 2) Start Postgres (Docker)
From the project root (or where your docker-compose.yml is):

```bash
docker compose up -d

Run DB migrations (powershell):
Get-Content db/001_init.sql | docker exec -i gochat-db psql -U gochat -d gochat
Get-Content db/002_messages.sql | docker exec -i gochat-db psql -U gochat -d gochat

Run the backend (from gochat-api):
$env:DATABASE_URL="postgres://gochat:gochat_pw@localhost:5432/gochat?sslmode=disable"
$env:JWT_SECRET="dev_secret_change_me"
go run .

Run the frontend (from gochat-pwa):
npm install
npm run dev 
