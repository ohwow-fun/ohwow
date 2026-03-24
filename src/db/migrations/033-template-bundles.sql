-- Template Bundles for local workspace

CREATE TABLE IF NOT EXISTS template_bundles (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  long_description TEXT,
  icon TEXT DEFAULT 'Lightning',
  category TEXT NOT NULL,
  business_types TEXT DEFAULT '[]',
  tags TEXT DEFAULT '[]',
  difficulty TEXT DEFAULT 'beginner',
  agents TEXT DEFAULT '[]',
  automations TEXT DEFAULT '[]',
  variables TEXT DEFAULT '[]',
  featured INTEGER DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  install_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS template_installs (
  id TEXT PRIMARY KEY,
  template_slug TEXT NOT NULL UNIQUE,
  agent_ids TEXT DEFAULT '[]',
  automation_ids TEXT DEFAULT '[]',
  variable_values TEXT DEFAULT '{}',
  installed_at TEXT DEFAULT (datetime('now'))
);
