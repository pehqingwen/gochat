CREATE TABLE IF NOT EXISTS messages (
  id            BIGSERIAL PRIMARY KEY,
  room_id       BIGINT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body          TEXT NOT NULL DEFAULT '',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),

  attachment_url      TEXT,
  attachment_mime     TEXT,
  attachment_filename TEXT,
  attachment_size     BIGINT
);

CREATE INDEX IF NOT EXISTS idx_messages_room_id_created_at
  ON messages(room_id, created_at DESC, id DESC);
