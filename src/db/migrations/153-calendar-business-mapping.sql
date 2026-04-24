-- @statement
ALTER TABLE calendar_accounts ADD COLUMN business_id TEXT;
-- @statement
ALTER TABLE calendar_accounts ADD COLUMN calendar_type TEXT DEFAULT 'personal';
