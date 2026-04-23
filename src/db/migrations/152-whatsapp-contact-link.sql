-- 152-whatsapp-contact-link.sql — link allowed WhatsApp chats to CRM contacts
-- or human teammates.
--
-- Follows the same nullable FK pattern as 127-x-dm-contact-linking.sql.
-- Both columns are optional; a chat can be linked to a contact, a teammate,
-- both, or neither. No ON DELETE CASCADE — if the contact/teammate is deleted
-- the chat stays in the allowlist, just unlinked (SET NULL).
--
-- Rollback is a no-op: both columns are nullable.

-- @statement
ALTER TABLE whatsapp_allowed_chats ADD COLUMN contact_id TEXT REFERENCES agent_workforce_contacts(id) ON DELETE SET NULL;

-- @statement
ALTER TABLE whatsapp_allowed_chats ADD COLUMN team_member_id TEXT REFERENCES agent_workforce_team_members(id) ON DELETE SET NULL;

-- @statement
CREATE INDEX IF NOT EXISTS idx_wa_chats_contact
  ON whatsapp_allowed_chats(contact_id);

-- @statement
CREATE INDEX IF NOT EXISTS idx_wa_chats_team_member
  ON whatsapp_allowed_chats(team_member_id);
