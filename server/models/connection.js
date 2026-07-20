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
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ])
  return JSON.parse(decrypted.toString('utf8'))
}

function rowToConn(conn) {
  return {
    id: conn.id,
    name: conn.name,
    type: conn.type,
    shared: Boolean(conn.shared),
    owner_id: conn.owner_id,
    created_at: conn.created_at,
    payload: decrypt(conn.encrypted_payload),
  }
}

/**
 * @param {string} name
 * @param {object} payload
 * @param {string} ownerId   Portainer user ID of the creator
 * @param {boolean} shared   Whether this target is visible to all users
 */
export function createConnection(name, payload, ownerId, shared = false) {
  const id = randomUUID()
  const encrypted_payload = encrypt(payload)
  db.prepare(
    `
    INSERT INTO connections (id, name, type, encrypted_payload, owner_id, shared)
    VALUES (?, ?, 'git', ?, ?, ?)
  `,
  ).run(id, name, encrypted_payload, ownerId, shared ? 1 : 0)
  return getConnectionById(id)
}

/**
 * @param {string} id
 * @returns {{ id, name, type, shared, owner_id, created_at, payload } | null}
 */
export function getConnectionById(id) {
  const conn = db.prepare('SELECT * FROM connections WHERE id = ?').get(id)
  if (!conn) return null
  return rowToConn(conn)
}

/**
 * Returns connections visible to a given user:
 * their own targets plus all shared targets.
 * @param {string} userId
 */
export function getConnectionsForUser(userId) {
  const rows = db
    .prepare(
      'SELECT * FROM connections WHERE owner_id = ? OR shared = 1 ORDER BY shared DESC, created_at ASC',
    )
    .all(userId)
  return rows.map(rowToConn)
}

/**
 * Returns ALL connections regardless of ownership — admin use only.
 */
export function getAllConnections() {
  const rows = db
    .prepare('SELECT * FROM connections ORDER BY created_at ASC')
    .all()
  return rows.map(rowToConn)
}

/**
 * @param {string} id
 * @param {string} name
 * @param {object} payload
 * @param {boolean} shared
 * @param {string} callerId   Must match owner_id or be admin
 * @param {boolean} isAdmin
 */
export function updateConnection(id, name, payload, shared, callerId, isAdmin) {
  const existing = getConnectionById(id)
  if (!existing) return null
  if (!isAdmin && existing.owner_id !== callerId) return 'forbidden'
  // Non-admins cannot set shared
  const newShared = isAdmin ? (shared ? 1 : 0) : existing.shared ? 1 : 0
  const encrypted_payload = encrypt(payload)
  const result = db
    .prepare(
      'UPDATE connections SET name = ?, encrypted_payload = ?, shared = ? WHERE id = ?',
    )
    .run(name, encrypted_payload, newShared, id)
  if (result.changes === 0) return null
  return getConnectionById(id)
}

/**
 * @param {string} id
 * @param {string} callerId
 * @param {boolean} isAdmin
 */
export function deleteConnection(id, callerId, isAdmin) {
  const existing = getConnectionById(id)
  if (!existing) return 'notfound'
  if (!isAdmin && existing.owner_id !== callerId) return 'forbidden'
  db.prepare('DELETE FROM connections WHERE id = ?').run(id)
  return 'ok'
}
