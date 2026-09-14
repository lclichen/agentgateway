ALTER TABLE request_logs ADD COLUMN IF NOT EXISTS agentgateway_session TEXT;

CREATE INDEX IF NOT EXISTS idx_request_logs_session_completed_at ON request_logs(agentgateway_session, completed_at DESC, id DESC);
