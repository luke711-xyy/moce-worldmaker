CREATE TABLE IF NOT EXISTS cloud_blobs (
  blob_hash TEXT PRIMARY KEY,
  r2_key TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cloud_assets (
  owner_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  name TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  category_path_json TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, asset_id),
  FOREIGN KEY (blob_hash) REFERENCES cloud_blobs(blob_hash)
);

CREATE INDEX IF NOT EXISTS cloud_assets_owner_updated_idx
  ON cloud_assets (owner_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS cloud_scenes (
  owner_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  name TEXT NOT NULL,
  current_version_id TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, scene_id)
);

CREATE TABLE IF NOT EXISTS cloud_scene_versions (
  owner_id TEXT NOT NULL,
  scene_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  name TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, scene_id, version_id),
  FOREIGN KEY (blob_hash) REFERENCES cloud_blobs(blob_hash)
);

CREATE INDEX IF NOT EXISTS cloud_scene_versions_owner_created_idx
  ON cloud_scene_versions (owner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS cloud_transfers (
  transfer_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('upload', 'download')),
  object_kind TEXT NOT NULL CHECK (object_kind IN ('asset', 'scene')),
  object_id TEXT NOT NULL,
  version_id TEXT,
  name TEXT NOT NULL,
  blob_hash TEXT NOT NULL,
  total_bytes INTEGER NOT NULL,
  total_parts INTEGER NOT NULL,
  completed_parts_json TEXT NOT NULL DEFAULT '[]',
  multipart_upload_id TEXT,
  temp_key TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL CHECK (status IN ('queued', 'transferring', 'reconnecting', 'completed', 'failed', 'cancelled')),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cloud_transfers_owner_expires_idx
  ON cloud_transfers (owner_id, expires_at);
