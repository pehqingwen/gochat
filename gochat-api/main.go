package main

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	"strconv"
	"sync"
	"bytes"
	"fmt"
	"io"
	"math/rand"
	"path/filepath"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"github.com/joho/godotenv"
)

type Server struct {
  db        *pgxpool.Pool
  jwtSecret []byte
  hub       *Hub
  uploadsDir string
}

type AuthRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type AuthResponse struct {
	Token string `json:"token"`
}

type Room struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	OwnerID  int64  `json:"owner_id"`
	IsOwner  bool   `json:"is_owner"`
	CreatedAt string `json:"created_at"`
}

type CreateRoomRequest struct {
	Name string `json:"name"`
}

type WSIn struct {
	Type     string `json:"type"`
	RoomID   int64  `json:"roomId"`
	Body     string `json:"body"`
	IsTyping bool   `json:"isTyping"`
	Status   string `json:"status"` // ✅ "active" | "idle"
	Attachment *Attachment `json:"attachment"`
}

type UserPresence struct {
	Email  string `json:"email"`
	Status string `json:"status"` // "active" | "idle"
}

type WSOut struct {
	Type      string         `json:"type"`
	RoomID    int64          `json:"roomId"`
	UserEmail string         `json:"userEmail,omitempty"`
	Users     []UserPresence `json:"users,omitempty"` // ✅ changed
	Body      string         `json:"body,omitempty"`
	IsTyping  bool           `json:"isTyping,omitempty"`
	CreatedAt int64          `json:"createdAt,omitempty"`
	Status    string         `json:"status,omitempty"` // ✅ for presence updates
	Attachment *Attachment `json:"attachment,omitempty"`
}

type Hub struct {
	mu    sync.Mutex
	rooms map[int64]map[*Client]bool
}

type Client struct {
	conn  *websocket.Conn
	email string
	room  int64
	status string
}

type Attachment struct {
	URL      string `json:"url"`
	Mime     string `json:"mime"`
	Filename string `json:"filename"`
	Size     int64  `json:"size"`
}

type MessageDTO struct {
	ID         int64       `json:"id"`
	RoomID     int64       `json:"roomId"`
	UserEmail  string      `json:"userEmail"`
	Body       string      `json:"body"`
	CreatedAt  int64       `json:"createdAt"` // unix ms
	Attachment *Attachment `json:"attachment,omitempty"`
}

func NewHub() *Hub {
	return &Hub{rooms: make(map[int64]map[*Client]bool)}
}

func (h *Hub) join(c *Client, roomID int64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.rooms[roomID] == nil {
		h.rooms[roomID] = make(map[*Client]bool)
	}
	h.rooms[roomID][c] = true
	c.room = roomID
}

func (h *Hub) leave(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if c.room == 0 {
		return
	}
	if m := h.rooms[c.room]; m != nil {
		delete(m, c)
		if len(m) == 0 {
			delete(h.rooms, c.room)
		}
	}
	c.room = 0
}

func (h *Hub) broadcastExcept(roomID int64, except *Client, msg WSOut) {
    h.mu.Lock()
    conns := make([]*Client, 0, len(h.rooms[roomID]))
    for c := range h.rooms[roomID] {
        if c != except {
            conns = append(conns, c)
        }
    }
    h.mu.Unlock()

    b, _ := json.Marshal(msg)
    for _, c := range conns {
        _ = c.conn.Write(context.Background(), websocket.MessageText, b)
    }
}

func (h *Hub) broadcast(roomID int64, msg WSOut) {
	h.mu.Lock()
	conns := make([]*Client, 0, len(h.rooms[roomID]))
	for c := range h.rooms[roomID] {
		conns = append(conns, c)
	}
	h.mu.Unlock()

	b, _ := json.Marshal(msg)
	for _, c := range conns {
		_ = c.conn.Write(context.Background(), websocket.MessageText, b)
	}
}

func (h *Hub) listPresences(roomID int64) []UserPresence {
	h.mu.Lock()
	defer h.mu.Unlock()

	out := []UserPresence{}
	for c := range h.rooms[roomID] {
		st := c.status
		if st == "" {
			st = "active"
		}
		out = append(out, UserPresence{Email: c.email, Status: st})
	}
	return out
}

func (h *Hub) sendToClient(c *Client, msg WSOut) {
	b, _ := json.Marshal(msg)
	_ = c.conn.Write(context.Background(), websocket.MessageText, b)
}

func (s *Server) handleCreateRoom(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	var req CreateRoomRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	name := strings.TrimSpace(req.Name)
	if name == "" || len(name) > 80 {
		writeErr(w, http.StatusBadRequest, "room name must be 1-80 chars")
		return
	}

	var roomID int64
	err := s.db.QueryRow(r.Context(),
		`INSERT INTO rooms (name, created_by) VALUES ($1, $2) RETURNING id`,
		name, userID,
	).Scan(&roomID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// creator becomes a member (owner)
	_, err = s.db.Exec(r.Context(),
		`INSERT INTO room_members (room_id, user_id, role) VALUES ($1, $2, 'owner')
		 ON CONFLICT (room_id, user_id) DO NOTHING`,
		roomID, userID,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{
		"id":   roomID,
		"name": name,
	})
}

func (s *Server) handleListRooms(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	rows, err := s.db.Query(r.Context(), `
		SELECT
			r.id,
			r.name,
			r.created_by,
			(r.created_by = $1) AS is_owner,
			r.created_at
		FROM rooms r
		JOIN room_members rm ON rm.room_id = r.id
		WHERE rm.user_id = $1
		ORDER BY r.created_at DESC
	`, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	var out []Room
	for rows.Next() {
		var rr Room
		var createdAt time.Time
		if err := rows.Scan(&rr.ID, &rr.Name, &rr.OwnerID, &rr.IsOwner, &createdAt); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		rr.CreatedAt = createdAt.Format(time.RFC3339)
		out = append(out, rr)
	}

	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleDeleteRoom(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	roomIDStr := chi.URLParam(r, "roomID")
	roomID, err := strconv.ParseInt(roomIDStr, 10, 64)
	if err != nil || roomID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid room id")
		return
	}

	// only creator can delete
	var ownerID int64
	err = s.db.QueryRow(r.Context(), `SELECT created_by FROM rooms WHERE id=$1`, roomID).Scan(&ownerID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "room not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	if ownerID != userID {
		writeErr(w, http.StatusForbidden, "only room creator can delete")
		return
	}

	_, err = s.db.Exec(r.Context(), `DELETE FROM rooms WHERE id=$1`, roomID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// cascades will remove room_members/messages due to ON DELETE CASCADE
	writeJSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {
	// Auth via query param token (works with browsers)
	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
		writeErr(w, http.StatusUnauthorized, "missing token")
		return
	}

	// Validate JWT (same secret)
	tok, err := jwt.Parse(tokenStr, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("unexpected signing method")
		}
		return s.jwtSecret, nil
	})
	if err != nil || !tok.Valid {
		writeErr(w, http.StatusUnauthorized, "invalid token")
		return
	}
	claims, ok := tok.Claims.(jwt.MapClaims)
	if !ok {
		writeErr(w, http.StatusUnauthorized, "invalid token claims")
		return
	}
	email, _ := claims["email"].(string)

	// Upgrade to WS
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// for local dev
		OriginPatterns: []string{"localhost:*"},
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	client := &Client{conn: conn, email: email}
	defer func() {
		// If client was in a room, announce leaving
		if client.room != 0 {
			s.hub.broadcast(client.room, WSOut{
				Type:      "user_left",
				RoomID:    client.room,
				UserEmail: client.email,
			})
		}
		s.hub.leave(client)
	}()

	for {
		_, data, err := conn.Read(r.Context())
		if err != nil {
			return
		}

		var in WSIn
		if err := json.Unmarshal(data, &in); err != nil {
			continue
		}

		// ✅ THIS is the “message switch”
		switch in.Type {
			case "join_room":
				if in.RoomID <= 0 {
					continue
				}

				client.status = "active" // ✅ default when joining
				s.hub.join(client, in.RoomID)

				// send snapshot to joiner
				users := s.hub.listPresences(in.RoomID)
				s.hub.sendToClient(client, WSOut{
					Type:   "user_list",
					RoomID: in.RoomID,
					Users:  users,
				})

				// announce joined (optional)
				s.hub.broadcast(in.RoomID, WSOut{
					Type:      "user_joined",
					RoomID:    in.RoomID,
					UserEmail: client.email,
					Status:    client.status,
				})

			case "presence":
				if client.room == 0 || client.room != in.RoomID {
					continue
				}

				st := in.Status
				if st != "active" && st != "idle" {
					continue
				}

				client.status = st

				s.hub.broadcast(in.RoomID, WSOut{
					Type:      "presence",
					RoomID:    in.RoomID,
					UserEmail: client.email,
					Status:    st,
				})

			case "message":
				if client.room == 0 || client.room != in.RoomID {
					continue
				}

				// Find user_id by email (or store user_id in Client at connect time)
				var userID int64
				err := s.db.QueryRow(r.Context(), `SELECT id FROM users WHERE email=$1`, client.email).Scan(&userID)
				if err != nil {
					continue
				}

				var msgID int64
				var createdAt time.Time

				att := in.Attachment
				_, _ = att, createdAt

				err = s.db.QueryRow(r.Context(), `
					INSERT INTO messages (
						room_id, user_id, body,
						attachment_url, attachment_mime, attachment_filename, attachment_size
					) VALUES ($1,$2,$3,$4,$5,$6,$7)
					RETURNING id, created_at
				`,
					in.RoomID, userID, in.Body,
					nullableStr(att, func(a *Attachment) string { return a.URL }),
					nullableStr(att, func(a *Attachment) string { return a.Mime }),
					nullableStr(att, func(a *Attachment) string { return a.Filename }),
					nullableSize(att),
				).Scan(&msgID, &createdAt)

				if err != nil {
					continue
				}

				s.hub.broadcast(in.RoomID, WSOut{
					Type:       "message",
					RoomID:     in.RoomID,
					UserEmail:  client.email,
					Body:       in.Body,
					Attachment: in.Attachment,
					CreatedAt:  createdAt.UnixMilli(),
					// If you want: include msgID so clients can paginate better:
					// MessageID: msgID,
				})


				// 2) Broadcast join to everyone (including joiner is okay; UI can ignore)
				s.hub.broadcast(in.RoomID, WSOut{
					Type:      "user_joined",
					RoomID:    in.RoomID,
					UserEmail: client.email,
				})
		case "typing":
			if client.room == 0 || client.room != in.RoomID {
				continue
			}
			s.hub.broadcast(in.RoomID, WSOut{
				Type:      "typing",
				RoomID:    in.RoomID,
				UserEmail: client.email,
				IsTyping:  in.IsTyping,
			})
		default:
			// ignore unknown types
		}
	}
}

func nullableStr(att *Attachment, f func(*Attachment) string) any {
	if att == nil {
		return nil
	}
	v := f(att)
	if v == "" {
		return nil
	}
	return v
}
func nullableSize(att *Attachment) any {
	if att == nil {
		return nil
	}
	if att.Size <= 0 {
		return nil
	}
	return att.Size
}

func (s *Server) handleJoinRoom(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	roomIDStr := chi.URLParam(r, "roomID")
	roomID, err := strconv.ParseInt(roomIDStr, 10, 64)
	if err != nil || roomID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid room id")
		return
	}

	// Ensure room exists
	var exists bool
	err = s.db.QueryRow(r.Context(), `SELECT true FROM rooms WHERE id=$1`, roomID).Scan(&exists)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			writeErr(w, http.StatusNotFound, "room not found")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Add membership (idempotent)
	_, err = s.db.Exec(r.Context(), `
		INSERT INTO room_members (room_id, user_id, role)
		VALUES ($1, $2, 'member')
		ON CONFLICT (room_id, user_id) DO NOTHING
	`, roomID, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "joined",
		"room_id": roomID,
	})
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request) {
	// 10 MB limit (adjust)
	r.Body = http.MaxBytesReader(w, r.Body, 10<<20)

	if err := r.ParseMultipartForm(10 << 20); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	f, hdr, err := r.FormFile("file")
	if err != nil {
		writeErr(w, http.StatusBadRequest, "missing file")
		return
	}
	defer f.Close()

	// Basic content-type sniffing
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	ctype := http.DetectContentType(head[:n])

	// Allow common image types + a few docs (edit as you like)
	allowed := map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
		"application/pdf": true,
	}
	if !allowed[ctype] {
		writeErr(w, http.StatusBadRequest, "file type not allowed")
		return
	}

	// Reset reader (we already read some bytes)
	reader := io.MultiReader(bytes.NewReader(head[:n]), f)

	ext := ""
	switch ctype {
	case "image/png":
		ext = ".png"
	case "image/jpeg":
		ext = ".jpg"
	case "image/gif":
		ext = ".gif"
	case "image/webp":
		ext = ".webp"
	case "application/pdf":
		ext = ".pdf"
	}

	name := fmt.Sprintf("%d_%s%s", time.Now().UnixNano(), randString(8), ext)
	path := filepath.Join(s.uploadsDir, name)

	out, err := os.Create(path)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "save failed")
		return
	}
	defer out.Close()

	size, err := io.Copy(out, reader)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "save failed")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"url":      "/uploads/" + name,
		"mime":     ctype,
		"size":     size,
		"filename": hdr.Filename,
	})
}

func randString(n int) string {
	const letters = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = letters[rand.Intn(len(letters))]
	}
	return string(b)
}

func mustGetwd() string {
	wd, err := os.Getwd()
	if err != nil {
		log.Fatal(err)
	}
	return wd
}

func (s *Server) handleListMessages(w http.ResponseWriter, r *http.Request) {
	roomIDStr := chi.URLParam(r, "roomID")
	roomID, err := strconv.ParseInt(roomIDStr, 10, 64)
	if err != nil || roomID <= 0 {
		log.Println("handleListMessages db error:", err)
writeErr(w, http.StatusInternalServerError, "db error")
return

	}

	userID := userIDFromCtx(r)

	// Must be a member of the room (or owner). Adjust if your schema differs.
	var ok bool
	err = s.db.QueryRow(r.Context(), `
		SELECT EXISTS(
			SELECT 1 FROM room_members
			WHERE room_id=$1 AND user_id=$2
		)
	`, roomID, userID).Scan(&ok)
	if err != nil {
		log.Println("handleListMessages db error:", err)
writeErr(w, http.StatusInternalServerError, "db error")
return

	}
	if !ok {
		log.Println("handleListMessages db error:", err)
writeErr(w, http.StatusInternalServerError, "db error")
return

	}

	// Pagination (simple): ?limit=50&before=<message_id>
	limit := int32(50)
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, _ := strconv.Atoi(v); n > 0 && n <= 200 {
			limit = int32(n)
		}
	}
	var beforeID int64 = 1<<62 // big
	if v := r.URL.Query().Get("before"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			beforeID = n
		}
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT
			m.id,
			m.room_id,
			u.email,
			m.body,
			(EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint AS created_ms,
			m.attachment_url,
			m.attachment_mime,
			m.attachment_filename,
			COALESCE(m.attachment_size, 0)
		FROM messages m
		JOIN users u ON u.id = m.user_id
		WHERE m.room_id = $1 AND m.id < $2
		ORDER BY m.id DESC
		LIMIT $3
	`, roomID, beforeID, limit)
	if err != nil {
		log.Println("handleListMessages db error:", err)
writeErr(w, http.StatusInternalServerError, "db error")
return

	}
	defer rows.Close()

	out := []MessageDTO{}
	for rows.Next() {
		var m MessageDTO
		var createdMS int64
		var url, mime, filename *string
		var size int64

		if err := rows.Scan(&m.ID, &m.RoomID, &m.UserEmail, &m.Body, &createdMS, &url, &mime, &filename, &size); err != nil {
			log.Println("handleListMessages db error:", err)
writeErr(w, http.StatusInternalServerError, "db error")
return

		}
		m.CreatedAt = createdMS

		if url != nil && *url != "" {
			m.Attachment = &Attachment{
				URL:      *url,
				Mime:     derefStr(mime),
				Filename: derefStr(filename),
				Size:     size,
			}
		}

		out = append(out, m)
	}
	if err := rows.Err(); err != nil {
		log.Println("handleListMessages db error:", err)
writeErr(w, http.StatusInternalServerError, "db error")
return

	}

	// Currently newest->oldest. Frontend can reverse to show oldest->newest.
	writeJSON(w, http.StatusOK, out)
}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func main() {
	dsn := mustEnv("DATABASE_URL")
	secret := mustEnv("JWT_SECRET")
	_ = godotenv.Load()

	ctx := context.Background()
	db, err := pgxpool.New(ctx, dsn)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	uploadsDir := filepath.Join(mustGetwd(), "uploads")
	_ = os.MkdirAll(uploadsDir, 0755)

	s := &Server{db: db, jwtSecret: []byte(secret), hub: NewHub(), uploadsDir: uploadsDir}

	r := chi.NewRouter()
	r.Use(cors)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	r.Post("/auth/register", s.handleRegister)
	r.Post("/auth/login", s.handleLogin)

	r.Get("/ws", s.handleWS)

	r.With(s.requireAuth).Get("/me", s.handleMe)
	r.With(s.requireAuth).Get("/rooms", s.handleListRooms)
	r.With(s.requireAuth).Post("/rooms", s.handleCreateRoom)
	r.With(s.requireAuth).Delete("/rooms/{roomID}", s.handleDeleteRoom)
	r.With(s.requireAuth).Post("/rooms/{roomID}/join", s.handleJoinRoom)
	r.With(s.requireAuth).Post("/upload", s.handleUpload)
	r.With(s.requireAuth).Get("/rooms/{roomID}/messages", s.handleListMessages)

	// ✅ serve uploaded files
	r.Handle("/uploads/*",
		http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadsDir))),
	)

	addr := envOr("ADDR", ":8080")
	log.Println("API listening on", addr)
	log.Fatal(http.ListenAndServe(addr, r))
}

func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req AuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	password := req.Password

	if !looksLikeEmail(email) {
		writeErr(w, http.StatusBadRequest, "invalid email")
		return
	}
	if len(password) < 8 {
		writeErr(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to hash password")
		return
	}

	var userID int64
	err = s.db.QueryRow(r.Context(),
		`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
		email, string(hash),
	).Scan(&userID)

	if err != nil {
		// handle unique violation (email already exists)
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			writeErr(w, http.StatusConflict, "email already registered")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	token, err := s.makeJWT(userID, email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to create token")
		return
	}

	writeJSON(w, http.StatusCreated, AuthResponse{Token: token})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req AuthRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	email := strings.ToLower(strings.TrimSpace(req.Email))
	password := req.Password

	if !looksLikeEmail(email) || password == "" {
		writeErr(w, http.StatusBadRequest, "invalid credentials")
		return
	}

	var userID int64
	var hash string
	err := s.db.QueryRow(r.Context(),
		`SELECT id, password_hash FROM users WHERE email=$1`,
		email,
	).Scan(&userID, &hash)

	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			// prevent account enumeration timing differences
			subtle.ConstantTimeCompare([]byte("a"), []byte("b"))
			writeErr(w, http.StatusUnauthorized, "invalid credentials")
			return
		}
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	if bcrypt.CompareHashAndPassword([]byte(hash), []byte(password)) != nil {
		writeErr(w, http.StatusUnauthorized, "invalid credentials")
		return
	}

	token, err := s.makeJWT(userID, email)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "failed to create token")
		return
	}

	writeJSON(w, http.StatusOK, AuthResponse{Token: token})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	id := userIDFromCtx(r)
	email := emailFromCtx(r)

	// optional: verify user still exists in DB
	var exists bool
	err := s.db.QueryRow(r.Context(), `SELECT true FROM users WHERE id=$1`, id).Scan(&exists)
	if err != nil {
		writeErr(w, http.StatusUnauthorized, "user not found")
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"id":    id,
		"email": email,
	})
}

// --- auth middleware + context helpers ---

type ctxKey string

const ctxUserID ctxKey = "userID"
const ctxEmail ctxKey = "email"

func (s *Server) requireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := r.Header.Get("Authorization")
		if h == "" || !strings.HasPrefix(h, "Bearer ") {
			writeErr(w, http.StatusUnauthorized, "missing bearer token")
			return
		}
		tokenStr := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))

		tok, err := jwt.Parse(tokenStr, func(token *jwt.Token) (any, error) {
			// enforce HS256
			if token.Method != jwt.SigningMethodHS256 {
				return nil, errors.New("unexpected signing method")
			}
			return s.jwtSecret, nil
		})
		if err != nil || !tok.Valid {
			writeErr(w, http.StatusUnauthorized, "invalid token")
			return
		}

		claims, ok := tok.Claims.(jwt.MapClaims)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "invalid token claims")
			return
		}

		// exp check
		if exp, ok := claims["exp"].(float64); ok {
			if time.Now().Unix() > int64(exp) {
				writeErr(w, http.StatusUnauthorized, "token expired")
				return
			}
		}

		// sub user id
		sub, ok := claims["sub"].(float64)
		if !ok {
			writeErr(w, http.StatusUnauthorized, "invalid token subject")
			return
		}
		userID := int64(sub)

		email, _ := claims["email"].(string)

		ctx := context.WithValue(r.Context(), ctxUserID, userID)
		ctx = context.WithValue(ctx, ctxEmail, email)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func userIDFromCtx(r *http.Request) int64 {
	v := r.Context().Value(ctxUserID)
	if id, ok := v.(int64); ok {
		return id
	}
	return 0
}

func emailFromCtx(r *http.Request) string {
	v := r.Context().Value(ctxEmail)
	if s, ok := v.(string); ok {
		return s
	}
	return ""
}

func (s *Server) makeJWT(userID int64, email string) (string, error) {
	claims := jwt.MapClaims{
		"sub":   userID,
		"email": email,
		"iat":   time.Now().Unix(),
		"exp":   time.Now().Add(7 * 24 * time.Hour).Unix(),
	}
	t := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return t.SignedString(s.jwtSecret)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		// allow local vite dev server + later your vercel domain
		if origin == "http://localhost:5173" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		}
		if r.Method == "OPTIONS" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func looksLikeEmail(s string) bool {
	// simple check for MVP
	return strings.Contains(s, "@") && strings.Contains(s, ".") && len(s) <= 254
}

func mustEnv(k string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		log.Fatalf("missing env %s", k)
	}
	return v
}

func envOr(k, def string) string {
	v := strings.TrimSpace(os.Getenv(k))
	if v == "" {
		return def
	}
	return v
}
