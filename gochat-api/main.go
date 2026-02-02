package main

import (
	"context"
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
	"database/sql"

	"github.com/coder/websocket"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/crypto/bcrypt"
	"github.com/joho/godotenv"  
	"github.com/go-chi/chi/v5/middleware"
	"github.com/google/uuid"
)

type Server struct {
  db        *pgxpool.Pool
  jwtSecret []byte
  hub       *Hub
  uploadsDir string

  callMu sync.Mutex
  calls  map[int64]*CallState // roomID -> state
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
	CreatedAt time.Time `json:"created_at"`
	UnreadCount int64 `json:"unreadCount"`
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
	ReplyToID  int64       `json:"replyToId"`
	 // WebRTC signaling
    To   string `json:"to,omitempty"`
    SDP  any    `json:"sdp,omitempty"`
    ICE  any    `json:"ice,omitempty"`
}

type UserPresence struct {
	Email  string `json:"email"`
	Status string `json:"status"` // "active" | "idle"
}

type WSOut struct {
	Type      string         `json:"type"`
	RoomID    int64          `json:"roomId"`

	MessageID int64          `json:"messageId,omitempty"` // ✅ add this

	UserEmail string         `json:"userEmail,omitempty"`
	Users     []UserPresence `json:"users,omitempty"`
	Body      string         `json:"body,omitempty"`
	IsTyping  bool           `json:"isTyping,omitempty"`
	CreatedAt int64          `json:"createdAt,omitempty"`
	Status    string         `json:"status,omitempty"`
	Attachment *Attachment   `json:"attachment,omitempty"`
	ReplyToID int64          `json:"replyToId,omitempty"` // (if you're doing replies)
	Deleted   bool           `json:"deleted,omitempty"`   // (optional)
	Call      CallState      `json:"call,omitempty"`
	Error string `json:"error,omitempty"`
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
	send chan []byte
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

	ReplyToID  int64       `json:"replyToId,omitempty"`
	Deleted    bool        `json:"deleted,omitempty"`

	Attachment *Attachment `json:"attachment,omitempty"`
	Edited bool `json:"edited,omitempty"`
	Starred bool `json:"starred,omitempty"`
	Reactions []ReactionDTO `json:"reactions"` 
	Kind string   `json:"kind"` 
	Poll *PollDTO `json:"poll,omitempty"`
}

type StarredMessageDTO struct {
	ID        int64       `json:"id"`
	RoomID    int64       `json:"roomId"`
	RoomName  string      `json:"roomName"`
	UserEmail string      `json:"userEmail"`
	Body      string      `json:"body"`
	CreatedAt int64       `json:"createdAt"`
	ReplyToID int64       `json:"replyToId"`
	Deleted   bool        `json:"deleted"`
	Edited    bool        `json:"edited"`
	Starred   bool        `json:"starred"`
	Attachment *Attachment `json:"attachment,omitempty"`
}

type editReq struct {
	Body string `json:"body"`
}

type ReactionEvent struct {
  Type      string `json:"type"`      // "reaction_added" | "reaction_removed"
  MessageID int64  `json:"messageId"`
  RoomID    int64  `json:"roomId"`
  Emoji     string `json:"emoji"`
  UserID    int64  `json:"userId"`
  Count     int64  `json:"count"`
}

type ReactionDTO struct {
    Emoji string `json:"emoji"`
    Count int64  `json:"count"`
    Me    bool   `json:"me"`
}

type ReactionUsersDTO struct {
	Emoji string   `json:"emoji"`
	Users []string `json:"users"`
}

type MessageReactionsDetailDTO struct {
	MessageID int64              `json:"messageId"`
	Items     []ReactionUsersDTO `json:"items"`
}

type PollOptionDTO struct {
	Text  string `json:"text"`
	Count int64  `json:"count,omitempty"` // computed when listing
}

type PollDTO struct {
	Question string       `json:"question"`
	Options  []PollOptionDTO `json:"options"`
	MyVote   int          `json:"myVote,omitempty"` // -1 if none
}

type editPollReq struct {
  Question string   `json:"question"`
  Options  []string `json:"options"`
}

type bulkIDsReq struct {
	MessageIDs []int64 `json:"messageIds"`
}

type bulkResult struct {
	OK       []int64          `json:"ok"`
	Failed   map[int64]string `json:"failed,omitempty"` // id -> reason
}

type CallState struct {
  Active       bool     `json:"active"`
  RoomID       int64    `json:"roomId"`
  HostEmail    string   `json:"host"`
  Participants []string `json:"participants"`
  StartedAtMS  int64    `json:"startedAt"`

  ScreenSharing bool   `json:"screenSharing"`
  ScreenSharer  string `json:"screenSharer"`
}


func nowMS() int64 { return time.Now().UnixMilli() }

func contains(ss []string, x string) bool {
  for _, s := range ss {
    if s == x { return true }
  }
  return false
}

func remove(ss []string, x string) []string {
  out := ss[:0]
  for _, s := range ss {
    if s != x { out = append(out, s) }
  }
  return out
}

func (s *Server) callRemoveParticipant(roomID int64, email string) (ended bool) {
	s.callMu.Lock()
	defer s.callMu.Unlock()

	cs := s.getCall(roomID)
	if !cs.Active {
		return false
	}

	cs.Participants = remove(cs.Participants, email)

	// if host left, you can either end call or reassign host:
	if cs.HostEmail == email {
		// simplest prototype: end call when host disconnects
		cs.Active = false
		cs.HostEmail = ""
		cs.Participants = nil
		cs.StartedAtMS = 0
		return true
	}

	// if nobody left, end
	if len(cs.Participants) == 0 {
		cs.Active = false
		cs.HostEmail = ""
		cs.StartedAtMS = 0
		return true
	}


	if cs.ScreenSharing && cs.ScreenSharer == email {
		cs.ScreenSharing = false
		cs.ScreenSharer = ""
	}


	return false
}

func (s *Server) getCall(roomID int64) *CallState {
  if s.calls == nil {
    s.calls = make(map[int64]*CallState)
  }
  cs := s.calls[roomID]
  if cs == nil {
    cs = &CallState{RoomID: roomID, Active: false}
    s.calls[roomID] = cs
  }
  return cs
}


func (s *Server) broadcastCallState(roomID int64) {
	// Take a snapshot under lock
	s.callMu.Lock()
	cs := s.getCall(roomID)

	out := CallState{
		Active:        cs.Active,
		RoomID:        roomID,
		HostEmail:     cs.HostEmail,
		StartedAtMS:   cs.StartedAtMS,
		ScreenSharing: cs.ScreenSharing,
		ScreenSharer:  cs.ScreenSharer,
	}

	// Always send participants as [] not null
	if cs.Participants != nil {
		out.Participants = append([]string(nil), cs.Participants...)
	} else {
		out.Participants = []string{}
	}

	s.callMu.Unlock()

	// Broadcast ONCE
	s.hub.broadcast(roomID, WSOut{
		Type:   "call_state",
		RoomID: roomID,
		Call:   out,
	})
}


func (s *Server) broadcastSystem(roomID int64, text string) {
  
	s.hub.BroadcastToRoom(roomID, map[string]any{
	"type":      "system",
	"roomId":    roomID,
	"eventId":   uuid.NewString(),
	"text":      text,
	"createdAt": time.Now().UnixMilli(),
	})

}


func (s *Server) handleBulkStarMessages(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	var body bulkIDsReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.MessageIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	// Insert stars; conflicts ignored
	// NOTE: for pgx, sending []int64 to ANY($2) is okay
	_, err := s.db.Exec(r.Context(), `
		INSERT INTO message_stars(user_id, message_id)
		SELECT $1, unnest($2::bigint[])
		ON CONFLICT DO NOTHING
	`, userID, body.MessageIDs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBulkUnstarMessages(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	var body bulkIDsReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.MessageIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	_, err := s.db.Exec(r.Context(), `
		DELETE FROM message_stars
		WHERE user_id = $1
		  AND message_id = ANY($2)
	`, userID, body.MessageIDs)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleBulkDeleteMessages(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	var body bulkIDsReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.MessageIDs) == 0 {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}

	// Update only messages owned by this user + not already deleted
	// Return ids + room_id so we can broadcast
	rows, err := s.db.Query(r.Context(), `
		UPDATE messages
		SET deleted_at = now(), body = ''
		WHERE id = ANY($1)
		  AND user_id = $2
		  AND deleted_at IS NULL
		RETURNING id, room_id
	`, body.MessageIDs, userID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	type delRow struct{ mid, rid int64 }
	var deleted []delRow

	for rows.Next() {
		var mid, rid int64
		if err := rows.Scan(&mid, &rid); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		deleted = append(deleted, delRow{mid: mid, rid: rid})
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Broadcast same event type your frontend already handles
	for _, d := range deleted {
		s.hub.broadcast(d.rid, WSOut{
			Type:      "message_deleted",
			RoomID:    d.rid,
			MessageID: d.mid,
		})
	}

	// Return list (handy for UI)
	writeJSON(w, http.StatusOK, map[string]any{
		"deletedIds": func() []int64 {
			out := make([]int64, 0, len(deleted))
			for _, d := range deleted {
				out = append(out, d.mid)
			}
			return out
		}(),
	})
}

func (s *Server) handleEditPoll(w http.ResponseWriter, r *http.Request) {
  userID := userIDFromCtx(r)

  msgIDStr := chi.URLParam(r, "messageID")
  msgID, err := strconv.ParseInt(msgIDStr, 10, 64)
  if err != nil || msgID <= 0 {
    writeErr(w, 400, "bad poll id")
    return
  }

  var roomID int64
  var ownerID int64
  var kind string
  var pollJSON string
  err = s.db.QueryRow(r.Context(), `
    SELECT room_id, user_id, kind, COALESCE(poll::text,'')
    FROM messages
    WHERE id=$1 AND deleted_at IS NULL
  `, msgID).Scan(&roomID, &ownerID, &kind, &pollJSON)
  if err != nil || kind != "poll" || pollJSON == "" {
    writeErr(w, 404, "poll not found")
    return
  }

  if ownerID != userID {
    writeErr(w, 403, "only poll creator can edit")
    return
  }

  // must still be room member (optional but recommended)
  var ok bool
  _ = s.db.QueryRow(r.Context(), `
    SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)
  `, roomID, userID).Scan(&ok)
  if !ok {
    writeErr(w, 403, "not a room member")
    return
  }

  var body editPollReq
  if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
    writeErr(w, 400, "bad json")
    return
  }

  body.Question = strings.TrimSpace(body.Question)
  if body.Question == "" {
    writeErr(w, 400, "question required")
    return
  }

  // normalize + validate options
  opts := make([]string, 0, len(body.Options))
  for _, o := range body.Options {
    t := strings.TrimSpace(o)
    if t != "" {
      opts = append(opts, t)
    }
  }
  if len(opts) < 2 || len(opts) > 6 {
    writeErr(w, 400, "options must be 2 to 6")
    return
  }

  // parse old poll to detect option changes
  var old struct {
    Question string `json:"question"`
    Options  []struct{ Text string `json:"text"` } `json:"options"`
  }
  _ = json.Unmarshal([]byte(pollJSON), &old)

  optionsChanged := len(old.Options) != len(opts)
  if !optionsChanged {
    for i := range opts {
      if old.Options[i].Text != opts[i] {
        optionsChanged = true
        break
      }
    }
  }

  // build new poll json
  stored := struct {
    Question string `json:"question"`
    Options  []struct{ Text string `json:"text"` } `json:"options"`
  }{
    Question: body.Question,
    Options:  make([]struct{ Text string `json:"text"` }, 0, len(opts)),
  }
  for _, t := range opts {
    stored.Options = append(stored.Options, struct{ Text string `json:"text"` }{Text: t})
  }
  pollBytes, _ := json.Marshal(stored)

  // transaction: update poll + maybe reset votes
  tx, err := s.db.Begin(r.Context())
  if err != nil { writeErr(w, 500, "db error"); return }
  defer tx.Rollback(r.Context())

  if _, err := tx.Exec(r.Context(), `
    UPDATE messages
    SET poll = $2::jsonb, edited_at = now()
    WHERE id = $1
  `, msgID, string(pollBytes)); err != nil {
    writeErr(w, 500, "db error")
    return
  }

  if optionsChanged {
    if _, err := tx.Exec(r.Context(), `DELETE FROM poll_votes WHERE message_id=$1`, msgID); err != nil {
      writeErr(w, 500, "db error")
      return
    }
  }

  if err := tx.Commit(r.Context()); err != nil {
    writeErr(w, 500, "db error")
    return
  }

  // return updated poll with counts (0 if reset) + myVote (-1 if reset)
  // easiest: reuse your vote handler’s “counts + myVote” builder logic here

  outPoll := &PollDTO{
    Question: body.Question,
    Options:  make([]PollOptionDTO, 0, len(opts)),
    MyVote:   -1,
  }
  for _, t := range opts {
    outPoll.Options = append(outPoll.Options, PollOptionDTO{Text: t, Count: 0})
  }

  s.hub.BroadcastToRoom(roomID, map[string]any{
    "type":      "poll_updated",
    "roomId":    roomID,
    "messageId": msgID,
    "poll":      outPoll,
  })

  writeJSON(w, 200, map[string]any{
    "messageId": msgID,
    "poll":      outPoll,
    "resetVotes": optionsChanged,
  })
}

func (c *Client) writeLoop() {
  ctx := context.Background()
  for b := range c.send {
    _ = c.conn.Write(ctx, websocket.MessageText, b)
  }
}

func (s *Server) handleListMessageReactions(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	msgIDStr := chi.URLParam(r, "messageID")
	msgID, err := strconv.ParseInt(msgIDStr, 10, 64)
	if err != nil || msgID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad message id")
		return
	}

	// ✅ ensure the requester is a member of the room containing this message
	var roomID int64
	if err := s.db.QueryRow(r.Context(), `SELECT room_id FROM messages WHERE id=$1`, msgID).Scan(&roomID); err != nil {
		writeErr(w, http.StatusNotFound, "message not found")
		return
	}
	var ok bool
	if err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)
	`, roomID, userID).Scan(&ok); err != nil || !ok {
		writeErr(w, http.StatusForbidden, "not a room member")
		return
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT mr.emoji, u.email
		FROM message_reactions mr
		JOIN users u ON u.id = mr.user_id
		WHERE mr.message_id = $1
		ORDER BY mr.emoji, u.email
	`, msgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	byEmoji := map[string][]string{}
	for rows.Next() {
		var emoji, email string
		if err := rows.Scan(&emoji, &email); err != nil {
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		byEmoji[emoji] = append(byEmoji[emoji], email)
	}

	out := MessageReactionsDetailDTO{MessageID: msgID}
	for emoji, users := range byEmoji {
		out.Items = append(out.Items, ReactionUsersDTO{Emoji: emoji, Users: users})
	}

	writeJSON(w, http.StatusOK, out)
}

func toggleReaction(ctx context.Context, db *pgxpool.Pool, roomID, messageID, userID int64, emoji string) (added bool, newCount int64, err error) {
  tx, err := db.Begin(ctx)
  if err != nil {
    return false, 0, err
  }
  defer func() {
    if err != nil {
      _ = tx.Rollback(ctx)
    }
  }()

  // Try delete first (toggle behavior)
  tag, err := tx.Exec(ctx,
    `DELETE FROM message_reactions
     WHERE message_id=$1 AND user_id=$2 AND emoji=$3`,
    messageID, userID, emoji,
  )
  if err != nil {
    return false, 0, err
  }

  if tag.RowsAffected() > 0 {
    added = false
  } else {
    _, err = tx.Exec(ctx,
      `INSERT INTO message_reactions(message_id, user_id, emoji)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      messageID, userID, emoji,
    )
    if err != nil {
      return false, 0, err
    }
    added = true
  }

  // Count current reactions for that emoji on that message
  err = tx.QueryRow(ctx,
    `SELECT COUNT(*) FROM message_reactions WHERE message_id=$1 AND emoji=$2`,
    messageID, emoji,
  ).Scan(&newCount)
  if err != nil {
    return false, 0, err
  }

  if err = tx.Commit(ctx); err != nil {
    return false, 0, err
  }
  return added, newCount, nil
}

func (h *Hub) BroadcastToRoom(roomID int64, v any) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	clients := h.rooms[roomID]
	for c := range clients {
		select {
		case c.send <- b:
		default:
			// drop or disconnect slow client
		}
	}
}

func (s *Server) handleToggleReaction(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)

	var body struct {
		RoomID    int64  `json:"roomId"`
		MessageID int64  `json:"messageId"`
		Emoji     string `json:"emoji"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.RoomID == 0 || body.MessageID == 0 || body.Emoji == "" {
		writeErr(w, http.StatusBadRequest, "bad request")
		return
	}

	added, count, err := toggleReaction(r.Context(), s.db, body.RoomID, body.MessageID, userID, body.Emoji)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	evType := "reaction_removed"
	if added {
		evType = "reaction_added"
	}

	ev := ReactionEvent{
		Type:      evType,
		RoomID:    body.RoomID,
		MessageID: body.MessageID,
		Emoji:     body.Emoji,
		Count:     count,
		UserID:    userID, // optional
	}

	// ✅ broadcast immediately to everyone in that room
	s.hub.BroadcastToRoom(body.RoomID, ev)

	// respond (optional; your frontend already sees WS update)
	writeJSON(w, http.StatusOK, ev)
}

func (s *Server) mustAuthUserID(r *http.Request) int64 {
    // TEMP: for testing only
    // send header: X-User-Id: 123
    v := r.Header.Get("X-User-Id")
    id, _ := strconv.ParseInt(v, 10, 64)
    if id <= 0 {
        return 0
    }
    return id
}

func (s *Server) handleListStarred(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)
	log.Println("handleListStarred userID=", userID)

	limit := int32(50)
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, _ := strconv.Atoi(v); n > 0 && n <= 200 {
			limit = int32(n)
		}
	}

	// pagination: ?beforeStar=<ms.created_at unix ms> optional
	var before time.Time
	if v := r.URL.Query().Get("beforeStar"); v != "" {
		if ms, err := strconv.ParseInt(v, 10, 64); err == nil && ms > 0 {
			before = time.Unix(0, ms*int64(time.Millisecond))
		}
	}

	// If before is zero, use "infinite future"
	if before.IsZero() {
		before = time.Now().Add(24 * time.Hour) // safely in the future
	}

	rows, err := s.db.Query(r.Context(), `
		SELECT
			m.id,
			m.room_id,
			COALESCE(r.name, '') AS room_name,
			u.email,
			m.body,
			(EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint AS created_ms,
			COALESCE(m.reply_to_id, 0) AS reply_to_id,
			(m.deleted_at IS NOT NULL) AS deleted,
			(m.edited_at IS NOT NULL) AS edited,
			TRUE AS starred,
			m.attachment_url,
			m.attachment_mime,
			m.attachment_filename,
			COALESCE(m.attachment_size, 0)
		FROM message_stars ms
		JOIN messages m ON m.id = ms.message_id
		JOIN users u ON u.id = m.user_id
		LEFT JOIN rooms r ON r.id = m.room_id
		-- safety: only return messages in rooms you're a member of
	
		WHERE ms.user_id = $1 AND ms.created_at < $2
		ORDER BY ms.created_at DESC
		LIMIT $3
	`, userID, before, limit)
	if err != nil {
		log.Println("handleListStarred db error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []StarredMessageDTO{}

	for rows.Next() {
		var m StarredMessageDTO
		var createdMS int64
		var replyToID int64
		var deleted, edited, starred bool
		var url, mime, filename *string
		var size int64

		if err := rows.Scan(
			&m.ID,
			&m.RoomID,
			&m.RoomName,
			&m.UserEmail,
			&m.Body,
			&createdMS,
			&replyToID,
			&deleted,
			&edited,
			&starred,
			&url,
			&mime,
			&filename,
			&size,
		); err != nil {
			log.Println("handleListStarred scan error:", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}

		m.CreatedAt = createdMS
		m.ReplyToID = replyToID
		m.Deleted = deleted
		m.Edited = edited
		m.Starred = starred

		if m.Deleted {
			m.Body = ""
			m.Attachment = nil
		} else if url != nil && *url != "" {
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
		log.Println("handleListStarred rows error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	log.Println("handleListStarred returning", len(out), "rows")

	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleEditMessage(w http.ResponseWriter, r *http.Request) {
	mid, _ := strconv.ParseInt(chi.URLParam(r, "messageID"), 10, 64)
	if mid <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid message id")
		return
	}

	userID := userIDFromCtx(r)

	var roomID int64
	var msgUserID int64
	err := s.db.QueryRow(r.Context(), `SELECT room_id, user_id FROM messages WHERE id=$1`, mid).
		Scan(&roomID, &msgUserID)
	if err != nil {
		writeErr(w, http.StatusNotFound, "not found")
		return
	}
	if msgUserID != userID {
		writeErr(w, http.StatusForbidden, "not allowed")
		return
	}

	var req editReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "invalid json")
		return
	}
	req.Body = strings.TrimSpace(req.Body)
	if req.Body == "" {
		writeErr(w, http.StatusBadRequest, "body required")
		return
	}
	if len(req.Body) > 4000 {
		writeErr(w, http.StatusBadRequest, "too long")
		return
	}

	_, err = s.db.Exec(r.Context(),
		`UPDATE messages SET body=$1, edited_at=now() WHERE id=$2`,
		req.Body, mid,
	)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// Broadcast to everyone in room
	s.hub.broadcast(roomID, WSOut{
		Type:      "message_edited",
		RoomID:    roomID,
		MessageID: mid,
		Body:      req.Body,
		// You can also include EditedAt if you add it to WSOut
	})

	w.WriteHeader(http.StatusNoContent)
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")

		allowed := map[string]bool{
			"http://localhost:5173":      true,
			"http://127.0.0.1:5173":      true,
			"http://192.168.1.12:5173":   true, // <-- change to your laptop IP
		}

		// If you want “any LAN IP” during dev:
		// if strings.HasPrefix(origin, "http://192.168.") && strings.HasSuffix(origin, ":5173") {
		//     allowed[origin] = true
		// }

		if allowed[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			// If you are NOT using cookies, you can omit this:
			// w.Header().Set("Access-Control-Allow-Credentials", "true")
		}

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
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
    oldRoom := c.room
    if oldRoom == 0 {
        return
    }

    // snapshot built while holding lock
    var users []UserPresence

    h.mu.Lock()
    // remove client from room
    if m := h.rooms[oldRoom]; m != nil {
        delete(m, c)
        if len(m) == 0 {
            delete(h.rooms, oldRoom)
        }
    }
    c.room = 0

    // build snapshot of remaining users in oldRoom
    users = h.listPresencesLocked(oldRoom)
    h.mu.Unlock()

    // broadcast AFTER unlock
    h.broadcast(oldRoom, WSOut{
        Type:      "presence",
        RoomID:    oldRoom,
        UserEmail: c.email,
        Status:    "inactive",
    })

    h.broadcast(oldRoom, WSOut{
        Type:   "user_list",
        RoomID: oldRoom,
        Users:  users,
    })
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
	return h.listPresencesLocked(roomID)

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
	// _ = c.conn.Write(context.Background(), websocket.MessageText, b)

	c.send <- b
}

func (h *Hub) listPresencesLocked(roomID int64) []UserPresence {
    m := h.rooms[roomID]
    if m == nil {
        return nil
    }

    // Deduplicate by email (multiple tabs = multiple clients)
    seen := map[string]UserPresence{}
    for c := range m {
        em := c.email
        if em == "" {
            continue
        }
        st := c.status
        if st == "" {
            st = "active"
        }

        // If any connection is active, keep active
        if prev, ok := seen[em]; ok {
            if prev.Status == "idle" && st == "active" {
                seen[em] = UserPresence{Email: em, Status: "active"}
            }
            continue
        }
        seen[em] = UserPresence{Email: em, Status: st}
    }

    out := make([]UserPresence, 0, len(seen))
    for _, p := range seen {
        out = append(out, p)
    }
    return out
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
  r.created_at,
  COALESCE((
    SELECT COUNT(*)
    FROM messages m
    LEFT JOIN room_reads rr ON rr.room_id = r.id AND rr.user_id = $1
    WHERE m.room_id = r.id
      AND m.id > COALESCE(rr.last_read_message_id, 0)
      AND m.deleted_at IS NULL
  ), 0)::bigint AS unread_count
FROM rooms r
JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
ORDER BY r.id DESC;
	`, userID)

	if err != nil {
		log.Println("handleListRooms query error:", err) // ✅ add
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	defer rows.Close()

	out := []Room{}
	for rows.Next() {
		var it Room
if err := rows.Scan(
  &it.ID,
  &it.Name,
  &it.OwnerID,
  &it.IsOwner,
  &it.CreatedAt,
  &it.UnreadCount,
); err != nil {
			log.Println("handleListRooms scan error:", err) // ✅ add
			writeErr(w, http.StatusInternalServerError, "db error")
			return
			}
			out = append(out, it)
		}
		if err := rows.Err(); err != nil {
			log.Println("handleListRooms rows error:", err) // ✅ add
			writeErr(w, http.StatusInternalServerError, "db error")
			return
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

func nullIfZero(v int64) any {
  if v == 0 { return nil }
  return v
}

func (s *Server) handleWS(w http.ResponseWriter, r *http.Request) {

	tokenStr := r.URL.Query().Get("token")
	if tokenStr == "" {
	http.Error(w, "missing token", http.StatusUnauthorized)
	return
	}

	// validate same as requireAuth:
	tok, err := jwt.Parse(tokenStr, func(token *jwt.Token) (any, error) {
	if token.Method != jwt.SigningMethodHS256 {
		return nil, errors.New("unexpected signing method")
	}
	return s.jwtSecret, nil
	})
	if err != nil || !tok.Valid {
	http.Error(w, "invalid token", http.StatusUnauthorized)
	return
	}
	claims := tok.Claims.(jwt.MapClaims)

	sub, _ := claims["sub"].(float64)
	userID := int64(sub)
	email, _ := claims["email"].(string)
	if userID <= 0 || email == "" {
	http.Error(w, "bad token claims", http.StatusUnauthorized)
	return
	}


	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns: []string{
			"http://localhost:5173",
			"http://127.0.0.1:5173",
			"http://192.168.1.12:5173", // your laptop IP
		},
	})
	if err != nil {
		log.Println("ws accept error:", err)
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "bye")

	client := &Client{conn: conn, email: email, send: make(chan []byte, 32)}
	go client.writeLoop()


	defer func() {
		// capture before leave() resets room to 0
		roomID := client.room
		em := client.email

		// 1) leave room -> broadcasts presence inactive + refreshed user_list
		s.hub.leave(client)

		// 2) remove from call state and broadcast call updates
		if roomID != 0 && em != "" {
			ended := s.callRemoveParticipant(roomID, em)

			s.broadcastCallState(roomID)
			s.broadcastSystem(roomID, "📹 "+em+" disconnected")
			if ended {
				s.broadcastSystem(roomID, "📹 call ended (no participants)")
			}
		}

		close(client.send)
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

				// if already in that room, ignore
				if client.room == in.RoomID {
					continue
				}

				// if switching rooms, leave old one first (optional)
				if client.room != 0 && client.room != in.RoomID {
					s.hub.leave(client)
				}
				client.status = "active" // ✅ default when joining
				s.hub.join(client, in.RoomID)

				// send snapshot to joiner
				users := s.hub.listPresences(in.RoomID)

				fmt.Println("[join_room] sending user_list to", client.email, "room", in.RoomID, "users:", users)

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

				
			case "leave_room":
				if in.RoomID <= 0 {
					continue
				}
				// only leave if they're leaving the room they're in
				if client.room == int64(in.RoomID) {
					s.hub.leave(client) // this will broadcast presence inactive + user_list (with your updated leave())
				}


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

				users := s.hub.listPresences(in.RoomID)

				s.hub.broadcast(in.RoomID, WSOut{
				Type:  "user_list",
				RoomID: in.RoomID,
				Users: users,
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
						reply_to_id,
						attachment_url, attachment_mime, attachment_filename, attachment_size
					) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
					RETURNING id, created_at
				`,
					in.RoomID, userID, in.Body,
					nullIfZero(in.ReplyToID),
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
					MessageID:  msgID,                 // ✅
					UserEmail:  client.email,
					Body:       in.Body,
					ReplyToID:  in.ReplyToID,           // if you have it
					Attachment: in.Attachment,
					CreatedAt:  createdAt.UnixMilli(),
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


		case "call_sync": {
		roomID := int64(in.RoomID)

		// ✅ just broadcast current state, no mutation, no system text
		s.broadcastCallState(roomID)
	}

	case "call_start": {
	roomID := int64(in.RoomID)
	email := client.email

	s.callMu.Lock()
	cs := s.getCall(roomID)
	if !cs.Active {
		cs.Active = true
		cs.HostEmail = email
		cs.StartedAtMS = time.Now().UnixMilli()
		cs.Participants = []string{email}
	} else if !contains(cs.Participants, email) {
		cs.Participants = append(cs.Participants, email)
	}
	s.callMu.Unlock()

	s.broadcastCallState(roomID)
	s.broadcastSystem(roomID, "📹 "+email+" started a call")
	}


	case "call_join": {
		roomID := int64(in.RoomID)
		email := client.email
		if email == "" {
			email = "unknown"
		}

		s.callMu.Lock()
		cs := s.getCall(roomID)
		if cs.Active {
			if !contains(cs.Participants, email) {
				cs.Participants = append(cs.Participants, email)
			}
		}
		s.callMu.Unlock()

		s.broadcastCallState(roomID)
		s.broadcastSystem(roomID, "📹 "+email+" joined the call")
	}

	case "call_leave": {
		roomID := int64(in.RoomID)
		email := client.email
		if email == "" {
			email = "unknown"
		}

		s.callMu.Lock()
		cs := s.getCall(roomID)
		if cs.Active {
			cs.Participants = remove(cs.Participants, email)

			// optional: if host leaves, end call (simple prototype)
			if cs.HostEmail == email {
				cs.Active = false
				cs.HostEmail = ""
				cs.Participants = nil
				cs.StartedAtMS = 0
			} else if len(cs.Participants) == 0 {
				cs.Active = false
				cs.HostEmail = ""
				cs.StartedAtMS = 0
			}
		}
		s.callMu.Unlock()

		s.broadcastCallState(roomID)
		s.broadcastSystem(roomID, "📹 "+email+" left the call")
	}

	case "call_end": {
		roomID := int64(in.RoomID)
		email := client.email
		if email == "" {
			email = "unknown"
		}

		s.callMu.Lock()
		cs := s.getCall(roomID)

		// only host can end (prototype rule)
		if cs.Active && cs.HostEmail == email {
			cs.Active = false
			cs.HostEmail = ""
			cs.Participants = nil
			cs.StartedAtMS = 0
		}
		s.callMu.Unlock()

		s.broadcastCallState(roomID)
		s.broadcastSystem(roomID, "📹 "+email+" ended the call")
	}

	case "webrtc_offer", "webrtc_answer", "webrtc_ice":
		// relay to everyone else in the room
		roomID := int64(in.RoomID)
		if roomID <= 0 {
			continue
		}

		// Important: include sender so peers can map connections
		// Assume client.email is set from token during WS auth
		s.hub.BroadcastToRoom(roomID, map[string]any{
			"type":   in.Type,
			"roomId": roomID,
			"from":   client.email,
			"to":     in.To,     // optional (can be empty)
			"sdp":    in.SDP,    // offer/answer
			"ice":    in.ICE,    // ice candidate
		})

	
	case "call_share_start": {
    roomID := int64(in.RoomID)
    email := client.email
    if roomID <= 0 || email == "" {
        continue
    }

    var rejectReason string

    s.callMu.Lock()
    cs := s.getCall(roomID)
    if !cs.Active {
        rejectReason = "no active call"
    } else if cs.ScreenSharing && cs.ScreenSharer != "" && cs.ScreenSharer != email {
        // ✅ Only one sharer at a time
        rejectReason = "someone is already sharing: " + cs.ScreenSharer
    } else {
        cs.ScreenSharing = true
        cs.ScreenSharer = email
    }
    s.callMu.Unlock()

    if rejectReason != "" {
        // send only to requester (not broadcast)
        s.hub.sendToClient(client, WSOut{
            Type:   "call_share_rejected",
            RoomID: roomID,
            Error:  rejectReason,
        })
        // optional: also send a system message ONLY to requester, not everyone
        // s.hub.sendToClient(client, WSOut{Type:"system", RoomID:roomID, Text:"🛑 Share rejected: "+rejectReason, CreatedAt: time.Now().UnixMilli()})
        continue
    }

    s.broadcastCallState(roomID)
    s.broadcastSystem(roomID, "🖥️ "+email+" started screen sharing")
}


case "call_share_stop": {
    roomID := int64(in.RoomID)
    email := client.email
    if roomID <= 0 || email == "" {
        continue
    }

    var rejectReason string

    s.callMu.Lock()
    cs := s.getCall(roomID)

    if cs.ScreenSharing {
        // ✅ only sharer can stop (simple rule)
        if cs.ScreenSharer != email {
            // OPTIONAL: allow host to stop anyone
            // if cs.HostEmail != email {
            //     rejectReason = "only current sharer (or host) can stop sharing"
            // } else {
            //     cs.ScreenSharing = false
            //     cs.ScreenSharer = ""
            // }
            rejectReason = "only current sharer can stop sharing"
        } else {
            cs.ScreenSharing = false
            cs.ScreenSharer = ""
        }
    }
    s.callMu.Unlock()

    if rejectReason != "" {
        s.hub.sendToClient(client, WSOut{
            Type:   "call_share_rejected",
            RoomID: roomID,
            Error:  rejectReason,
        })
        continue
    }

    s.broadcastCallState(roomID)
    s.broadcastSystem(roomID, "🖥️ "+email+" stopped screen sharing")
}


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
	log.Println("UPLOAD start", r.Method, r.URL.Path, "Content-Length:", r.ContentLength, "Origin:", r.Header.Get("Origin"))

	const maxUpload = 200 << 20 // 200MB (adjust)

	r.Body = http.MaxBytesReader(w, r.Body, maxUpload)

	if err := r.ParseMultipartForm(maxUpload); err != nil {
		log.Println("UPLOAD ParseMultipartForm error:", err)
		writeErr(w, http.StatusBadRequest, "invalid multipart form")
		return
	}

	f, hdr, err := r.FormFile("file")

	if err != nil {
		log.Println("UPLOAD FormFile error:", err)
		writeErr(w, http.StatusBadRequest, "missing file")
		return
	}
	
	log.Println("UPLOAD got file:", hdr.Filename, "size(header):", hdr.Size)

	defer f.Close()

	// Basic content-type sniffing
	head := make([]byte, 512)
	n, _ := io.ReadFull(f, head)
	ctype := http.DetectContentType(head[:n])

	// Allow common image types + a few docs (edit as you like)
	allowed := map[string]bool{
		"image/png": true, "image/jpeg": true, "image/gif": true, "image/webp": true,
		"application/pdf": true,

		"video/mp4": true,
		"video/webm": true,

		// ✅ WAV (common variants)
		"audio/wav": true,
		"audio/wave": true,
		"audio/x-wav": true,
		"audio/vnd.wave": true,
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
	case "video/mp4":
		ext = ".mp4"
	case "video/webm":
		ext = ".webm"
	// ✅ WAV variants
	case "audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave":
		ext = ".wav"
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
		writeErr(w, http.StatusBadRequest, "bad room id")
		return
	}

	userID := userIDFromCtx(r)

	// Must be a member
	var ok bool
	err = s.db.QueryRow(r.Context(), `
		SELECT EXISTS(
			SELECT 1 FROM room_members
			WHERE room_id=$1 AND user_id=$2
		)
	`, roomID, userID).Scan(&ok)
	if err != nil {
		log.Println("handleListMessages membership error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if !ok {
		writeErr(w, http.StatusForbidden, "not a room member")
		return
	}

	// Query params
	limit := int32(50)
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, _ := strconv.Atoi(v); n > 0 && n <= 200 {
			limit = int32(n)
		}
	}

	sinceDays := 10
	if v := r.URL.Query().Get("sinceDays"); v != "" {
		if n, _ := strconv.Atoi(v); n >= 1 && n <= 365 {
			sinceDays = n
		}
	}

	beforeID := int64(1<<62)
	beforeProvided := false
	if v := r.URL.Query().Get("before"); v != "" {
		if n, e := strconv.ParseInt(v, 10, 64); e == nil && n > 0 {
			beforeID = n
			beforeProvided = true
		}
	}

	// Fetch messages
	var rows pgx.Rows
	
if !beforeProvided {
  // ✅ initial load: only last N days
  rows, err = s.db.Query(r.Context(), `
    SELECT
      m.id, m.room_id, u.email, m.body, m.kind,
      COALESCE(m.poll::text, '') AS poll_json,
      (EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint AS created_ms,
      COALESCE(m.reply_to_id, 0) AS reply_to_id,
      (m.deleted_at IS NOT NULL) AS deleted,
      (m.edited_at IS NOT NULL) AS edited,
      (ms.message_id IS NOT NULL) AS starred,
      m.attachment_url, m.attachment_mime, m.attachment_filename,
      COALESCE(m.attachment_size, 0)
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN message_stars ms ON ms.message_id=m.id AND ms.user_id=$4
    WHERE m.room_id=$1
      AND m.id < $2
      AND m.created_at >= now() - ($3::int * interval '1 day')
    ORDER BY m.id DESC
    LIMIT $5
  `, roomID, beforeID, sinceDays, userID, limit)

} else {
  // ✅ load older: no date restriction
  rows, err = s.db.Query(r.Context(), `
    SELECT
      m.id, m.room_id, u.email, m.body, m.kind,
      COALESCE(m.poll::text, '') AS poll_json,
      (EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint AS created_ms,
      COALESCE(m.reply_to_id, 0) AS reply_to_id,
      (m.deleted_at IS NOT NULL) AS deleted,
      (m.edited_at IS NOT NULL) AS edited,
      (ms.message_id IS NOT NULL) AS starred,
      m.attachment_url, m.attachment_mime, m.attachment_filename,
      COALESCE(m.attachment_size, 0)
    FROM messages m
    JOIN users u ON u.id = m.user_id
    LEFT JOIN message_stars ms ON ms.message_id=m.id AND ms.user_id=$3
    WHERE m.room_id=$1
      AND m.id < $2
    ORDER BY m.id DESC
    LIMIT $4
  `, roomID, beforeID, userID, limit)
}

if err != nil {
  log.Println("handleListMessages query error:", err)
  writeErr(w, http.StatusInternalServerError, "db error")
  return
}
defer rows.Close()

	out := make([]MessageDTO, 0, limit)

	for rows.Next() {
		var m MessageDTO
		var createdMS int64
		var replyToID int64
		var deleted, edited, starred bool
		var url, mime, filename *string
		var size int64
		var kind string
		var pollJSON string

		if err := rows.Scan(
			&m.ID,
			&m.RoomID,
			&m.UserEmail,
			&m.Body,
			&kind,
			&pollJSON,
			&createdMS,
			&replyToID,
			&deleted,
			&edited,
			&starred,
			&url,
			&mime,
			&filename,
			&size,
		); err != nil {
			log.Println("handleListMessages scan error:", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}

		m.CreatedAt = createdMS
		m.ReplyToID = replyToID
		m.Deleted = deleted
		m.Edited = edited
		m.Starred = starred
		m.Kind = kind

		if m.Deleted {
			m.Body = ""
			m.Attachment = nil
		} else if url != nil && *url != "" {
			m.Attachment = &Attachment{
				URL:      *url,
				Mime:     derefStr(mime),
				Filename: derefStr(filename),
				Size:     size,
			}
		}

		// Basic poll reconstruction (counts added later)
		if kind == "poll" && pollJSON != "" && !m.Deleted {
			var stored struct {
				Question string `json:"question"`
				Options  []struct {
					Text string `json:"text"`
				} `json:"options"`
			}
			if err := json.Unmarshal([]byte(pollJSON), &stored); err == nil {
				p := &PollDTO{Question: stored.Question, MyVote: -1}
				for _, o := range stored.Options {
					p.Options = append(p.Options, PollOptionDTO{Text: o.Text, Count: 0})
				}
				m.Poll = p
			}
		}

		out = append(out, m)
	}

	if err := rows.Err(); err != nil {
		log.Println("handleListMessages rows error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// ---- rebuild poll counts + myVote on refresh ----
	pollIDs := make([]int64, 0)
	pollIndex := make(map[int64]int)
	for i := range out {
		if out[i].Deleted {
			continue
		}
		if out[i].Kind == "poll" && out[i].Poll != nil {
			pollIDs = append(pollIDs, out[i].ID)
			pollIndex[out[i].ID] = i
		}
	}

	if len(pollIDs) > 0 {
		type key struct{ mid int64; idx int }
		counts := make(map[key]int64)

		r1, e := s.db.Query(r.Context(), `
			SELECT message_id, option_idx, COUNT(*)::bigint
			FROM poll_votes
			WHERE message_id = ANY($1)
			GROUP BY message_id, option_idx
		`, pollIDs)
		if e != nil {
			writeErr(w, 500, "failed to load poll counts")
			return
		}
		for r1.Next() {
			var mid int64
			var idx int
			var cnt int64
			if err := r1.Scan(&mid, &idx, &cnt); err == nil {
				counts[key{mid: mid, idx: idx}] = cnt
			}
		}
		r1.Close()

		myVotes := make(map[int64]int)
		r2, e := s.db.Query(r.Context(), `
			SELECT message_id, option_idx
			FROM poll_votes
			WHERE message_id = ANY($1) AND user_id = $2
		`, pollIDs, userID)
		if e != nil {
			writeErr(w, 500, "failed to load my poll votes")
			return
		}
		for r2.Next() {
			var mid int64
			var idx int
			if err := r2.Scan(&mid, &idx); err == nil {
				myVotes[mid] = idx
			}
		}
		r2.Close()

		for _, mid := range pollIDs {
			i := pollIndex[mid]
			p := out[i].Poll
			if p == nil {
				continue
			}
			if v, ok := myVotes[mid]; ok {
				p.MyVote = v
			} else {
				p.MyVote = -1
			}
			for optIdx := range p.Options {
				p.Options[optIdx].Count = counts[key{mid: mid, idx: optIdx}]
			}
		}
	}
	// ---- end poll rebuild ----

	
	if err := rows.Err(); err != nil {
		log.Println("handleListMessages db error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

		// 1) collect message ids (these are DB ids: m.id)
	ids := make([]int64, 0, len(out))
	for _, m := range out {
		ids = append(ids, m.ID)
	}

	// 2) load reactions for those ids
	reactionsByMsg := map[int64][]ReactionDTO{}

	if len(ids) > 0 {
		rxRows, err := s.db.Query(r.Context(), `
			SELECT
				message_id,
				emoji,
				COUNT(*)::bigint AS cnt,
				BOOL_OR(user_id = $2) AS me
			FROM message_reactions
			WHERE message_id = ANY($1)
			GROUP BY message_id, emoji
			ORDER BY message_id, emoji
		`, ids, userID)
		if err != nil {
			log.Println("handleListMessages reactions query error:", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		defer rxRows.Close()

		for rxRows.Next() {
			var mid int64
			var emoji string
			var cnt int64
			var me bool
			if err := rxRows.Scan(&mid, &emoji, &cnt, &me); err != nil {
				log.Println("handleListMessages reactions scan error:", err)
				writeErr(w, http.StatusInternalServerError, "db error")
				return
			}
			reactionsByMsg[mid] = append(reactionsByMsg[mid], ReactionDTO{
				Emoji: emoji,
				Count: cnt,
				Me:    me,
			})
		}
		if err := rxRows.Err(); err != nil {
			log.Println("handleListMessages reactions rows error:", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
	}

	// 3) attach to messages
	for i := range out {
		mid := out[i].ID
		out[i].Reactions = reactionsByMsg[mid]
	}

	log.Println("handleListMessages roomID=", roomID, "userID=", userID, "messages=", len(out))
	log.Println("reaction groups found=", len(reactionsByMsg))

	// 4) respond (newest->oldest; frontend can reverse)
	writeJSON(w, http.StatusOK, out)

}

func derefStr(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

func initDB() (*sql.DB, error) {
    connString := os.Getenv("DATABASE_URL")
    if connString == "" {
        // local fallback (edit as needed)
        connString = "postgres://postgres:postgres@localhost:5432/gochat?sslmode=disable"
    }

    db, err := sql.Open("pgx", connString)
    if err != nil {
        return nil, err
    }

    // optional pool tuning
    db.SetMaxOpenConns(10)
    db.SetMaxIdleConns(10)
    db.SetConnMaxLifetime(30 * time.Minute)

    // IMPORTANT: actually test connectivity
    ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
    defer cancel()

    if err := db.PingContext(ctx); err != nil {
        _ = db.Close()
        return nil, err
    }

    return db, nil
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

	s := &Server{
		db: db,
		jwtSecret: []byte(secret),
		hub: NewHub(),
		uploadsDir: uploadsDir,
		calls: make(map[int64]*CallState),
	}

	r := chi.NewRouter()
	r.Use(cors)
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte("ok"))
	})

	r.Post("/auth/register", s.handleRegister)
	r.Post("/auth/login", s.handleLogin)
	r.With(s.requireAuth).Post("/reactions/toggle", s.handleToggleReaction)

	r.Get("/ws", s.handleWS)

	r.With(s.requireAuth).Get("/me", s.handleMe)
	r.With(s.requireAuth).Get("/rooms", s.handleListRooms)
	r.With(s.requireAuth).Post("/rooms", s.handleCreateRoom)
	r.With(s.requireAuth).Delete("/rooms/{roomID}", s.handleDeleteRoom)
	r.With(s.requireAuth).Post("/rooms/{roomID}/join", s.handleJoinRoom)
	r.With(s.requireAuth).Post("/upload", s.handleUpload)
	r.With(s.requireAuth).Get("/rooms/{roomID}/messages", s.handleListMessages)
	r.With(s.requireAuth).Delete("/messages/{messageID}", s.handleDeleteMessage)
	r.With(s.requireAuth).Put("/messages/{messageID}", s.handleEditMessage)
	r.With(s.requireAuth).Post("/messages/{messageID}/star", s.handleStarMessage)
	r.With(s.requireAuth).Get("/starred", s.handleListStarred)
	r.With(s.requireAuth).Delete("/messages/{messageID}/star", s.handleUnstarMessage)
	r.With(s.requireAuth).Get("/rooms/{roomID}/messages/search", s.handleSearchMessages)
	r.With(s.requireAuth).Post("/rooms/{roomID}/read", s.handleMarkRoomRead)
	r.With(s.requireAuth).Post("/rooms/{roomID}/leave", s.handleLeaveRoom)
	r.With(s.requireAuth).Get("/messages/{messageID}/reactions", s.handleListMessageReactions)
	r.With(s.requireAuth).Post("/rooms/{roomID}/polls", s.handleCreatePoll)
	r.With(s.requireAuth).Post("/polls/{messageID}/vote", s.handleVotePoll)
	r.With(s.requireAuth).Put("/polls/{messageID}", s.handleEditPoll)
	r.With(s.requireAuth).Post("/messages/bulk/star", s.handleBulkStarMessages)
	r.With(s.requireAuth).Post("/messages/bulk/unstar", s.handleBulkUnstarMessages)
	r.With(s.requireAuth).Post("/messages/bulk/delete", s.handleBulkDeleteMessages)


	// ✅ serve uploaded files
	r.Handle("/uploads/*",
		http.StripPrefix("/uploads/", http.FileServer(http.Dir(uploadsDir))),
	)

	addr := envOr("ADDR", ":8080")
	log.Println("API listening on", addr)
	log.Fatal(http.ListenAndServe(addr, r))
}

type votePollReq struct {
	OptionIdx int `json:"optionIdx"`
}

func (s *Server) handleVotePoll(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)
	email := emailFromCtx(r) // optional

	msgIDStr := chi.URLParam(r, "messageID")
	msgID, err := strconv.ParseInt(msgIDStr, 10, 64)
	if err != nil || msgID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad poll id")
		return
	}

	// load poll message + room + poll json
	var roomID int64
	var kind string
	var pollJSON *string
	err = s.db.QueryRow(r.Context(), `
		SELECT room_id, kind, poll::text
		FROM messages
		WHERE id=$1 AND deleted_at IS NULL
	`, msgID).Scan(&roomID, &kind, &pollJSON)
	if err != nil || kind != "poll" || pollJSON == nil || *pollJSON == "" {
		writeErr(w, http.StatusNotFound, "poll not found")
		return
	}

	// must be member
	var ok bool
	if err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)
	`, roomID, userID).Scan(&ok); err != nil || !ok {
		writeErr(w, http.StatusForbidden, "not a room member")
		return
	}

	var body votePollReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}

	// parse stored poll to validate option range
	var stored struct {
		Question string `json:"question"`
		Options  []struct {
			Text string `json:"text"`
		} `json:"options"`
	}
	if err := json.Unmarshal([]byte(*pollJSON), &stored); err != nil {
		writeErr(w, http.StatusInternalServerError, "bad poll data")
		return
	}
	if body.OptionIdx < 0 || body.OptionIdx >= len(stored.Options) {
		writeErr(w, http.StatusBadRequest, "bad option index")
		return
	}

	// ---- TOGGLE / SWITCH VOTE (transaction recommended) ----
	tx, err := s.db.Begin(r.Context())
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(r.Context())

	// read existing vote (if any)
	existing := -1
	err = tx.QueryRow(r.Context(), `
		SELECT option_idx
		FROM poll_votes
		WHERE message_id=$1 AND user_id=$2
	`, msgID, userID).Scan(&existing)

	myVote := -1

	if err == nil {
		// had a vote already
		if existing == body.OptionIdx {
			// ✅ clicked same option -> cancel vote
			if _, err := tx.Exec(r.Context(), `
				DELETE FROM poll_votes
				WHERE message_id=$1 AND user_id=$2
			`, msgID, userID); err != nil {
				log.Println("vote poll delete error:", err)
				writeErr(w, http.StatusInternalServerError, "db error")
				return
			}
			myVote = -1
		} else {
			// ✅ switch vote
			if _, err := tx.Exec(r.Context(), `
				UPDATE poll_votes
				SET option_idx=$3, created_at=now()
				WHERE message_id=$1 AND user_id=$2
			`, msgID, userID, body.OptionIdx); err != nil {
				log.Println("vote poll update error:", err)
				writeErr(w, http.StatusInternalServerError, "db error")
				return
			}
			myVote = body.OptionIdx
		}
	} else if errors.Is(err, pgx.ErrNoRows) {
		// no previous vote -> insert
		if _, err := tx.Exec(r.Context(), `
			INSERT INTO poll_votes (message_id, user_id, option_idx)
			VALUES ($1, $2, $3)
		`, msgID, userID, body.OptionIdx); err != nil {
			log.Println("vote poll insert error:", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}
		myVote = body.OptionIdx
	} else {
		log.Println("vote poll read existing error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	// counts (inside same tx so it's consistent)
	counts := make([]int64, len(stored.Options))
	rows, err := tx.Query(r.Context(), `
		SELECT option_idx, COUNT(*)::bigint
		FROM poll_votes
		WHERE message_id=$1
		GROUP BY option_idx
	`, msgID)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	for rows.Next() {
		var idx int
		var cnt int64
		if err := rows.Scan(&idx, &cnt); err == nil && idx >= 0 && idx < len(counts) {
			counts[idx] = cnt
		}
	}
	if err := rows.Err(); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	if err := tx.Commit(r.Context()); err != nil {
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	// ---- END TOGGLE / SWITCH ----

	outPoll := &PollDTO{
		Question: stored.Question,
		Options:  make([]PollOptionDTO, 0, len(stored.Options)),
		MyVote:   myVote, // ✅ -1 if cancelled
	}
	for i, o := range stored.Options {
		outPoll.Options = append(outPoll.Options, PollOptionDTO{
			Text:  o.Text,
			Count: counts[i],
		})
	}

	// broadcast
	s.hub.BroadcastToRoom(roomID, map[string]any{
		"type":      "poll_updated",
		"roomId":    roomID,
		"messageId": msgID,
		"poll":      outPoll,
		"userEmail": email,
	})

	writeJSON(w, http.StatusOK, map[string]any{
		"messageId": msgID,
		"poll":      outPoll,
	})
}

type createPollReq struct {
	Question string   `json:"question"`
	Options  []string `json:"options"`
}

type pollStoredJSON struct {
	Question string `json:"question"`
	Options  []struct {
		Text string `json:"text"`
	} `json:"options"`
}

func (s *Server) handleCreatePoll(w http.ResponseWriter, r *http.Request) {
	userID := userIDFromCtx(r)
	email := emailFromCtx(r) // if you have it; if not, remove this line and the field below

	roomIDStr := chi.URLParam(r, "roomID")
	roomID, err := strconv.ParseInt(roomIDStr, 10, 64)
	if err != nil || roomID <= 0 {
		writeErr(w, http.StatusBadRequest, "bad room id")
		return
	}

	// must be member
	var ok bool
	if err := s.db.QueryRow(r.Context(), `
		SELECT EXISTS(SELECT 1 FROM room_members WHERE room_id=$1 AND user_id=$2)
	`, roomID, userID).Scan(&ok); err != nil || !ok {
		writeErr(w, http.StatusForbidden, "not a room member")
		return
	}

	var body createPollReq
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json")
		return
	}
	body.Question = strings.TrimSpace(body.Question)
	if body.Question == "" {
		writeErr(w, http.StatusBadRequest, "question required")
		return
	}
	if len(body.Options) < 2 || len(body.Options) > 6 {
		writeErr(w, http.StatusBadRequest, "options must be 2 to 6")
		return
	}

	opts := make([]PollOptionDTO, 0, len(body.Options))
	for _, o := range body.Options {
		t := strings.TrimSpace(o)
		if t == "" {
			writeErr(w, http.StatusBadRequest, "option text required")
			return
		}
		opts = append(opts, PollOptionDTO{Text: t})
	}

	pollStored := PollDTO{
		Question: body.Question,
		Options:  opts,
		MyVote:   -1,
	}

	stored := pollStoredJSON{
		Question: pollStored.Question,
		Options:  make([]struct{ Text string `json:"text"` }, 0, len(pollStored.Options)),
	}

	for _, o := range pollStored.Options {
		stored.Options = append(stored.Options, struct {
			Text string `json:"text"`
		}{Text: o.Text})
	}

	pollBytes, _ := json.Marshal(stored)

	var msgID int64
	var createdMS int64

	// Insert poll as a message
	err = s.db.QueryRow(r.Context(), `
		INSERT INTO messages (room_id, user_id, body, kind, poll, created_at)
		VALUES ($1, $2, '', 'poll', $3::jsonb, now())
		RETURNING id, (EXTRACT(EPOCH FROM created_at) * 1000)::bigint
	`, roomID, userID, string(pollBytes)).Scan(&msgID, &createdMS)
	if err != nil {
		log.Println("create poll insert error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	out := MessageDTO{
		ID:        msgID,
		RoomID:    roomID,
		UserEmail: email,
		Body:      "",
		CreatedAt: createdMS,
		Kind:      "poll",
		Poll: &PollDTO{
			Question: pollStored.Question,
			Options:  pollStored.Options, // counts empty
			MyVote:   -1,
		},
	}

	// Broadcast like other realtime events
	s.hub.BroadcastToRoom(roomID, map[string]any{
		"type":      "message",
		"roomId":    roomID,
		"messageId": msgID,
		"userEmail": email,
		"body":      "",
		"createdAt": createdMS,
		"kind":      "poll",
		"poll":      out.Poll,
	})

	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleLeaveRoom(w http.ResponseWriter, r *http.Request) {
  userID := userIDFromCtx(r)

  roomIDStr := chi.URLParam(r, "roomID")
  roomID, err := strconv.ParseInt(roomIDStr, 10, 64)
  if err != nil || roomID <= 0 {
    writeErr(w, http.StatusBadRequest, "bad room id")
    return
  }

  // optional: prevent owner leaving their own room
  var ownerID int64
  if err := s.db.QueryRow(r.Context(), `SELECT owner_id FROM rooms WHERE id=$1`, roomID).Scan(&ownerID); err == nil {
    if ownerID == userID {
      writeErr(w, http.StatusBadRequest, "owner cannot leave their own room")
      return
    }
  }

  _, err = s.db.Exec(r.Context(), `
    DELETE FROM room_members
    WHERE room_id=$1 AND user_id=$2
  `, roomID, userID)
  if err != nil {
    writeErr(w, http.StatusInternalServerError, "db error")
    return
  }

  w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleMarkRoomRead(w http.ResponseWriter, r *http.Request) {
  roomIDStr := chi.URLParam(r, "roomID")
  roomID, err := strconv.ParseInt(roomIDStr, 10, 64)
  if err != nil || roomID <= 0 {
    writeErr(w, http.StatusBadRequest, "bad room id")
    return
  }

  userID := userIDFromCtx(r)

  var body struct {
    LastReadMessageID int64 `json:"lastReadMessageId"`
  }
  if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.LastReadMessageID <= 0 {
    writeErr(w, http.StatusBadRequest, "lastReadMessageId required")
    return
  }

  _, err = s.db.Exec(r.Context(), `
    INSERT INTO room_reads(room_id, user_id, last_read_message_id, updated_at)
    VALUES ($1, $2, $3, now())
    ON CONFLICT (room_id, user_id)
    DO UPDATE SET last_read_message_id = GREATEST(room_reads.last_read_message_id, EXCLUDED.last_read_message_id),
                  updated_at = now()
  `, roomID, userID, body.LastReadMessageID)
  if err != nil {
    writeErr(w, http.StatusInternalServerError, "db error")
    return
  }

  w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleSearchMessages(w http.ResponseWriter, r *http.Request) {
	roomID, err := strconv.ParseInt(chi.URLParam(r, "roomID"), 10, 64)
	if err != nil || roomID <= 0 {
		writeErr(w, http.StatusBadRequest, "invalid room id")
		return
	}

	userID := userIDFromCtx(r)

	// membership check
	var ok bool
	err = s.db.QueryRow(r.Context(), `
		SELECT EXISTS(
			SELECT 1 FROM room_members
			WHERE room_id=$1 AND user_id=$2
		)
	`, roomID, userID).Scan(&ok)
	if err != nil {
		log.Println("handleSearchMessages db error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	if !ok {
		writeErr(w, http.StatusForbidden, "not a room member")
		return
	}

	q := strings.TrimSpace(r.URL.Query().Get("q"))
	if q == "" {
		writeErr(w, http.StatusBadRequest, "missing q")
		return
	}
	if len(q) > 200 {
		writeErr(w, http.StatusBadRequest, "query too long")
		return
	}

	limit := int32(50)
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, _ := strconv.Atoi(v); n > 0 && n <= 200 {
			limit = int32(n)
		}
	}

	// optional pagination: results before message id
	var beforeID int64 = 1<<62
	if v := r.URL.Query().Get("before"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil && n > 0 {
			beforeID = n
		}
	}

	// Pattern for ILIKE
	pat := "%" + q + "%"

	rows, err := s.db.Query(r.Context(), `
	SELECT
		m.id, m.room_id, u.email, m.body,
		(EXTRACT(EPOCH FROM m.created_at) * 1000)::bigint AS created_ms,
		COALESCE(m.reply_to_id, 0) AS reply_to_id,
		(m.deleted_at IS NOT NULL) AS deleted,
		(m.edited_at IS NOT NULL) AS edited,
		(ms.message_id IS NOT NULL) AS starred,
		m.attachment_url, m.attachment_mime, m.attachment_filename,
		COALESCE(m.attachment_size, 0), m.kind, COALESCE(m.poll::text, '') AS poll_json
	FROM messages m
	JOIN users u ON u.id = m.user_id
	LEFT JOIN message_stars ms ON ms.message_id = m.id AND ms.user_id = $4
	WHERE m.room_id = $1
		AND m.deleted_at IS NULL
		AND m.id < $3
		AND (
		m.body ILIKE $2
		OR u.email ILIKE $2
		OR COALESCE(m.attachment_filename,'') ILIKE $2
		OR (
			m.kind = 'poll' AND (
			COALESCE(m.poll->>'question','') ILIKE $2
			OR EXISTS (
				SELECT 1
				FROM jsonb_array_elements(COALESCE(m.poll->'options','[]'::jsonb)) opt
				WHERE COALESCE(opt->>'text','') ILIKE $2
			)
			)
		)
		)
	ORDER BY m.id DESC
	LIMIT $5
	`, roomID, pat, beforeID, userID, limit)


	if err != nil {
		log.Println("handleSearchMessages db error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}
	defer rows.Close()

	out := []MessageDTO{}

	for rows.Next() {
		var m MessageDTO
		var createdMS int64
		var replyToID int64
		var deleted, edited, starred bool
		var url, mime, filename *string
		var size int64
		var kind string
		var pollJSON string

		if err := rows.Scan(
			&m.ID,
			&m.RoomID,
			&m.UserEmail,
			&m.Body,
			&createdMS,
			&replyToID,
			&deleted,
			&edited,
			&starred,
			&url,
			&mime,
			&filename,
			&size,
			&kind,
			&pollJSON,

		); err != nil {
			log.Println("handleSearchMessages scan error:", err)
			writeErr(w, http.StatusInternalServerError, "db error")
			return
		}

		m.CreatedAt = createdMS
		m.ReplyToID = replyToID
		m.Deleted = deleted
		m.Edited = edited
		m.Starred = starred
		m.Kind = kind

		if kind == "poll" && pollJSON != "" && !m.Deleted {
		// parse stored poll
		var stored struct {
			Question string `json:"question"`
			Options  []struct{ Text string `json:"text"` } `json:"options"`
		}
		if err := json.Unmarshal([]byte(pollJSON), &stored); err == nil {
			// counts
			counts := make([]int64, len(stored.Options))
			r2, err := s.db.Query(r.Context(), `
			SELECT option_idx, COUNT(*)::bigint
			FROM poll_votes
			WHERE message_id=$1
			GROUP BY option_idx
			`, m.ID)
			if err == nil {
			for r2.Next() {
				var idx int
				var cnt int64
				if r2.Scan(&idx, &cnt) == nil && idx >= 0 && idx < len(counts) {
				counts[idx] = cnt
				}
			}
			r2.Close()
			}

			// myVote
			myVote := -1
			_ = s.db.QueryRow(r.Context(), `
			SELECT COALESCE((SELECT option_idx FROM poll_votes WHERE message_id=$1 AND user_id=$2), -1)
			`, m.ID, userID).Scan(&myVote)

			outPoll := &PollDTO{Question: stored.Question, MyVote: myVote}
			for i, o := range stored.Options {
			outPoll.Options = append(outPoll.Options, PollOptionDTO{Text: o.Text, Count: counts[i]})
			}
			m.Poll = outPoll
		}
		}


		if m.Deleted {
			m.Body = ""
			m.Attachment = nil
		} else if url != nil && *url != "" {
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
		log.Println("handleSearchMessages rows error:", err)
		writeErr(w, http.StatusInternalServerError, "db error")
		return
	}

	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleStarMessage(w http.ResponseWriter, r *http.Request) {
  mid, _ := strconv.ParseInt(chi.URLParam(r, "messageID"), 10, 64)
  if mid <= 0 { writeErr(w, 400, "invalid message id"); return }
  userID := userIDFromCtx(r)

  // optional: ensure user can see the message (member of room)
  _, err := s.db.Exec(r.Context(), `
    INSERT INTO message_stars(user_id, message_id)
    VALUES ($1,$2)
    ON CONFLICT DO NOTHING
  `, userID, mid)
  if err != nil { writeErr(w, 500, "db error"); return }

  w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleUnstarMessage(w http.ResponseWriter, r *http.Request) {
  mid, _ := strconv.ParseInt(chi.URLParam(r, "messageID"), 10, 64)
  if mid <= 0 { writeErr(w, 400, "invalid message id"); return }
  userID := userIDFromCtx(r)

  _, err := s.db.Exec(r.Context(), `
    DELETE FROM message_stars WHERE user_id=$1 AND message_id=$2
  `, userID, mid)
  if err != nil { writeErr(w, 500, "db error"); return }

  w.WriteHeader(http.StatusNoContent)
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
	log.Println("handleLogin start")

  var req AuthRequest
  if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
    log.Println("handleLogin decode error:", err)
    writeErr(w, http.StatusBadRequest, "invalid json")
    return
  }
  log.Println("handleLogin email:", req.Email)

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

	if errors.Is(err, pgx.ErrNoRows) {
  writeErr(w, http.StatusUnauthorized, "invalid credentials")
  return
}
if err != nil {
  log.Println("handleLogin db error:", err) // ✅ THIS is what we need
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

func (s *Server) handleDeleteMessage(w http.ResponseWriter, r *http.Request) {
  mid, _ := strconv.ParseInt(chi.URLParam(r, "messageID"), 10, 64)
  if mid <= 0 { writeErr(w, 400, "invalid message id"); return }

  userID := userIDFromCtx(r)

  // get room_id + owner check
  var roomID int64
  var msgUserID int64
  err := s.db.QueryRow(r.Context(), `SELECT room_id, user_id FROM messages WHERE id=$1`, mid).
    Scan(&roomID, &msgUserID)
  if err != nil { writeErr(w, 404, "not found"); return }

  if msgUserID != userID {
    writeErr(w, 403, "not allowed")
    return
  }

  _, err = s.db.Exec(r.Context(), `
    UPDATE messages
    SET deleted_at = now(), body = ''
    WHERE id=$1
  `, mid)
  if err != nil { writeErr(w, 500, "db error"); return }

  // broadcast delete to room
	s.hub.broadcast(roomID, WSOut{
		Type:      "message_deleted",
		RoomID:    roomID,
		MessageID: mid,
	})

  w.WriteHeader(http.StatusNoContent)
}
