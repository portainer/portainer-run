import { Database } from 'bun:sqlite'
import path from 'node:path'
import fs from 'node:fs'
import { projectRoot } from '../config.js'

const DB_DIR = path.join(projectRoot, 'data')
const DB_PATH = path.join(DB_DIR, 'portainer-run.db')

if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true })
}

const db = new Database(DB_PATH, { create: true })

// Enable WAL mode for better concurrent read performance
db.exec('PRAGMA journal_mode = WAL')
db.exec('PRAGMA foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS connections (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    type              TEXT NOT NULL DEFAULT 'git',
    encrypted_payload TEXT NOT NULL,
    owner_id          TEXT NOT NULL DEFAULT '_system',
    shared            INTEGER NOT NULL DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );
`)

// Key-value store for internal config (e.g. gateway PSK)
db.exec(`
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`)

// Safe migrations for existing databases that pre-date owner_id / shared columns
for (const [col, def] of [
  ['owner_id', "TEXT NOT NULL DEFAULT '_system'"],
  ['shared', 'INTEGER NOT NULL DEFAULT 0'],
]) {
  const exists = db
    .prepare(`PRAGMA table_info(connections)`)
    .all()
    .some((r) => r.name === col)
  if (!exists) db.exec(`ALTER TABLE connections ADD COLUMN ${col} ${def}`)
}

export default db
