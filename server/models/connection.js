import crypto from 'node:crypto'
import { randomUUID } from 'node:crypto'
import db from '../db/db.js'

const ALGORITHM = 'aes-256-gcm'

function getKey() {
  const key = process.env.ENCRYPTION_KEY
  if (!key || key.length < 32) {
    throw new Error('ENCRYPTION_KEY env var must be at least 32 characters')
  }
  return Buffer.from(key.slice(0, 32))
}

function encrypt(payload) {
  const iv = crypto.randomBytes(16)
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv)
  const json = JSON.stringify(payload)
  const encrypted = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [iv, tag, encrypted].map((b) => b.toString('hex')).join(':')
}

function decrypt(stored) {
  const [ivHex, tagHex, encHex] = stored.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const tag = Buffer.from(tagHex, 'hex')
  const encrypted = Buffer.from(encHex, 'hex')
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()])
  return JSON.parse(decrypted.toString('utf8'))
}

/**
 * @param {string} name
 * @param {object} payload  { provider, repo, token, url, username, authType, defaultBranch, pathPrefix }
 */
export function createConnection(name, payload) {
  const id = randomUUID()
  const encrypted_payload = encrypt(payload)
  db.prepare(`
    INSERT INTO connections (id, name, type, encrypted_payload)
    VALUES (?, ?, 'git', ?)
  `).run(id, name, encrypted_payload)
  return getConnectionById(id)
}

/**
 * @param {string} id
 * @returns {{ id, name, type, created_at, payload } | null}
 */
export function getConnectionById(id) {
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(id)
  if (!conn) return null
  return { ...conn, payload: decrypt(conn.encrypted_payload), encrypted_payload: undefined }
}

/**
 * Returns all connections with payload decrypted.
 * For list views, callers should strip sensitive fields (token, sshKey).
 */
export function getAllConnections() {
  const rows = db.prepare('SELECT * FROM connections ORDER BY created_at ASC').all()
  return rows.map((conn) => ({
    id: conn.id,
    name: conn.name,
    type: conn.type,
    created_at: conn.created_at,
    payload: decrypt(conn.encrypted_payload),
  }))
}

/**
 * @param {string} id
 * @param {string} name
 * @param {object} payload
 */
export function updateConnection(id, name, payload) {
  const encrypted_payload = encrypt(payload)
  const result = db
    .prepare('UPDATE connections SET name = ?, encrypted_payload = ? WHERE id = ?')
    .run(name, encrypted_payload, id)
  if (result.changes === 0) return null
  return getConnectionById(id)
}

/**
 * @param {string} id
 */
export function deleteConnection(id) {
  return db.prepare('DELETE FROM connections WHERE id = ?').run(id)
}
