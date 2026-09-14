CREATE TABLE IF NOT EXISTS message_feedback (
	session_id TEXT NOT NULL,
	entry_id TEXT NOT NULL,
	value TEXT NOT NULL,
	snippet TEXT,
	client_created_at BIGINT,
	server_created_at TIMESTAMPTZ NOT NULL,
	username TEXT,
	model TEXT,
	log_id TEXT,
	PRIMARY KEY (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS idx_message_feedback_server_created_at ON message_feedback(server_created_at);
CREATE INDEX IF NOT EXISTS idx_message_feedback_session ON message_feedback(session_id);
