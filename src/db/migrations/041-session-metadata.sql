-- Add session metadata columns for granular session management
ALTER TABLE orchestrator_chat_sessions ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orchestrator_chat_sessions ADD COLUMN device_name TEXT DEFAULT NULL;
