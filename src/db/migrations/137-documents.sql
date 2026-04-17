-- Document templates
-- @statement
CREATE TABLE IF NOT EXISTS document_templates (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  name             TEXT NOT NULL,
  description      TEXT,
  doc_type         TEXT NOT NULL DEFAULT 'other',
  body_template    TEXT NOT NULL,
  variables        TEXT DEFAULT '[]',
  header_html      TEXT,
  footer_html      TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_document_templates_workspace ON document_templates(workspace_id);

-- Generated documents
-- @statement
CREATE TABLE IF NOT EXISTS documents (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  template_id      TEXT REFERENCES document_templates(id),
  contact_id       TEXT REFERENCES agent_workforce_contacts(id),
  deal_id          TEXT REFERENCES deals(id),
  title            TEXT NOT NULL,
  doc_type         TEXT NOT NULL,
  body_rendered    TEXT NOT NULL,
  variables_used   TEXT DEFAULT '{}',
  status           TEXT NOT NULL DEFAULT 'draft',
  sent_at          TEXT,
  viewed_at        TEXT,
  signed_at        TEXT,
  expired_at       TEXT,
  signature_provider TEXT,
  signature_ref    TEXT,
  pdf_path         TEXT,
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_documents_workspace ON documents(workspace_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_documents_contact ON documents(contact_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_documents_deal ON documents(deal_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(workspace_id, status);
