CREATE TABLE IF NOT EXISTS objects (
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('asset', 'scene')),
  id TEXT NOT NULL,
  name TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  summary_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, kind, id)
);

CREATE INDEX IF NOT EXISTS objects_owner_kind_updated_idx
  ON objects (owner_id, kind, updated_at DESC);

CREATE TABLE IF NOT EXISTS asset_categories (
  owner_id TEXT NOT NULL,
  path_key TEXT NOT NULL,
  path_json TEXT NOT NULL,
  PRIMARY KEY (owner_id, path_key)
);
