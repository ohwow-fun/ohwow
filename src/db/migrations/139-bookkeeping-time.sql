-- Expense categories
-- @statement
CREATE TABLE IF NOT EXISTS expense_categories (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  name             TEXT NOT NULL,
  parent_id        TEXT REFERENCES expense_categories(id),
  color            TEXT,
  is_active        INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_expense_categories_workspace ON expense_categories(workspace_id);

-- Expenses
-- @statement
CREATE TABLE IF NOT EXISTS expenses (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  category_id      TEXT REFERENCES expense_categories(id),
  team_member_id   TEXT,
  amount_cents     INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'USD',
  description      TEXT NOT NULL,
  vendor           TEXT,
  receipt_path     TEXT,
  expense_date     TEXT NOT NULL,
  is_recurring     INTEGER NOT NULL DEFAULT 0,
  recurrence_rule  TEXT,
  tax_deductible   INTEGER NOT NULL DEFAULT 0,
  tags             TEXT DEFAULT '[]',
  metadata         TEXT DEFAULT '{}',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_expenses_workspace ON expenses(workspace_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(workspace_id, expense_date DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category_id);

-- Time entries
-- @statement
CREATE TABLE IF NOT EXISTS time_entries (
  id               TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  workspace_id     TEXT NOT NULL,
  team_member_id   TEXT NOT NULL,
  project_id       TEXT,
  deal_id          TEXT,
  ticket_id        TEXT,
  description      TEXT,
  duration_minutes INTEGER NOT NULL,
  entry_date       TEXT NOT NULL,
  start_time       TEXT,
  end_time         TEXT,
  billable         INTEGER NOT NULL DEFAULT 1,
  hourly_rate_cents INTEGER,
  tags             TEXT DEFAULT '[]',
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
-- @statement
CREATE INDEX IF NOT EXISTS idx_time_entries_workspace ON time_entries(workspace_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_time_entries_member ON time_entries(team_member_id, entry_date DESC);
-- @statement
CREATE INDEX IF NOT EXISTS idx_time_entries_project ON time_entries(project_id);
-- @statement
CREATE INDEX IF NOT EXISTS idx_time_entries_date ON time_entries(workspace_id, entry_date DESC);
