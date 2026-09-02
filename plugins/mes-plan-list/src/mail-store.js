/**
 * 邮件功能的私有持久化。
 *
 * 这个数据库与可重建的 plans.db 完全分开：设置、人员邮箱映射和发送记录都属于
 * 用户数据，升级时只能迁移，不能通过删库重建来处理结构变化。
 */
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export const MAIL_DB_PATH = join(homedir(), '.dsh', 'storages', 'mes-plan-list', 'mail.db')

const SCHEMA_VERSION = 1

const MIGRATIONS = [
  `
  CREATE TABLE mail_settings (
    profile_key TEXT PRIMARY KEY,
    sender_name TEXT NOT NULL,
    sender_email TEXT NOT NULL,
    smtp_host TEXT NOT NULL,
    smtp_port INTEGER NOT NULL,
    security_mode TEXT NOT NULL,
    smtp_username TEXT NOT NULL,
    subject_template TEXT NOT NULL,
    body_template TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE executor_emails (
    profile_key TEXT NOT NULL,
    executor_id TEXT NOT NULL CHECK (trim(executor_id) <> ''),
    executor_name TEXT NOT NULL,
    email TEXT NOT NULL CHECK (trim(email) <> ''),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (profile_key, executor_id)
  );
  CREATE TABLE send_batches (
    id INTEGER PRIMARY KEY,
    profile_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    total_messages INTEGER NOT NULL,
    succeeded INTEGER NOT NULL,
    failed INTEGER NOT NULL
  );
  CREATE INDEX send_batches_profile ON send_batches (profile_key, created_at DESC);
  CREATE TABLE send_results (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES send_batches(id) ON DELETE CASCADE,
    executor_id TEXT NOT NULL,
    executor_name TEXT NOT NULL,
    masked_email TEXT NOT NULL,
    plan_ids_json TEXT NOT NULL,
    status TEXT NOT NULL,
    error_code TEXT NOT NULL
  );
  `,
]

/** 原始 MES 账号不进入数据库或钥匙串标识。 */
export function profileKey(account) {
  const normalized = String(account ?? '').trim()
  if (normalized === '') throw new Error('MES 账号不能为空')
  return createHash('sha256').update(normalized).digest('hex')
}

function settingsFromRow(row) {
  if (row === undefined) return undefined
  return {
    senderName: row.sender_name,
    senderEmail: row.sender_email,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    securityMode: row.security_mode,
    smtpUsername: row.smtp_username,
    subjectTemplate: row.subject_template,
    bodyTemplate: row.body_template,
  }
}

function mappingFromRow(row) {
  return {
    executorId: row.executor_id,
    executorName: row.executor_name,
    email: row.email,
  }
}

export class MailStore {
  #db

  constructor(path = MAIL_DB_PATH) {
    this.path = path
  }

  #open() {
    if (this.#db !== undefined) return this.#db
    mkdirSync(dirname(this.path), { recursive: true })
    this.#db = new DatabaseSync(this.path)
    this.#db.exec('PRAGMA foreign_keys = ON')
    const [{ user_version: version }] = this.#db.prepare('PRAGMA user_version').all()
    if (version > SCHEMA_VERSION) {
      this.#db.close()
      this.#db = undefined
      throw new Error('邮件数据库版本高于当前插件版本')
    }
    for (let next = version + 1; next <= SCHEMA_VERSION; next += 1) {
      this.#db.exec('BEGIN IMMEDIATE')
      try {
        this.#db.exec(MIGRATIONS[next - 1])
        this.#db.exec(`PRAGMA user_version = ${next}`)
        this.#db.exec('COMMIT')
      } catch (error) {
        this.#db.exec('ROLLBACK')
        throw error
      }
    }
    return this.#db
  }

  close() {
    this.#db?.close()
    this.#db = undefined
  }

  readSettings(profile) {
    const row = this.#open().prepare('SELECT * FROM mail_settings WHERE profile_key = ?').get(profile)
    return settingsFromRow(row)
  }

  writeSettings(profile, settings, updatedAt = new Date().toISOString()) {
    this.#open().prepare(`
      INSERT INTO mail_settings (
        profile_key, sender_name, sender_email, smtp_host, smtp_port, security_mode,
        smtp_username, subject_template, body_template, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(profile_key) DO UPDATE SET
        sender_name = excluded.sender_name,
        sender_email = excluded.sender_email,
        smtp_host = excluded.smtp_host,
        smtp_port = excluded.smtp_port,
        security_mode = excluded.security_mode,
        smtp_username = excluded.smtp_username,
        subject_template = excluded.subject_template,
        body_template = excluded.body_template,
        updated_at = excluded.updated_at
    `).run(
      profile,
      settings.senderName,
      settings.senderEmail,
      settings.smtpHost,
      settings.smtpPort,
      settings.securityMode,
      settings.smtpUsername,
      settings.subjectTemplate,
      settings.bodyTemplate,
      updatedAt,
    )
    return this.readSettings(profile)
  }

  listMappings(profile) {
    return this.#open()
      .prepare('SELECT executor_id, executor_name, email FROM executor_emails WHERE profile_key = ? ORDER BY executor_id')
      .all(profile)
      .map(mappingFromRow)
  }

  replaceMappings(profile, rows, updatedAt = new Date().toISOString()) {
    if (!Array.isArray(rows)) throw new Error('邮箱映射必须是数组')
    const db = this.#open()
    const remove = db.prepare('DELETE FROM executor_emails WHERE profile_key = ?')
    const insert = db.prepare(`
      INSERT INTO executor_emails (profile_key, executor_id, executor_name, email, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `)
    db.exec('BEGIN IMMEDIATE')
    try {
      remove.run(profile)
      for (const row of rows) {
        insert.run(profile, row.executorId, row.executorName, row.email, updatedAt)
      }
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return this.listMappings(profile)
  }

  deleteMapping(profile, executorId) {
    const result = this.#open()
      .prepare('DELETE FROM executor_emails WHERE profile_key = ? AND executor_id = ?')
      .run(profile, executorId)
    return result.changes === 1
  }

  writeBatch(profile, batch) {
    const db = this.#open()
    const insertBatch = db.prepare(`
      INSERT INTO send_batches (profile_key, created_at, total_messages, succeeded, failed)
      VALUES (?, ?, ?, ?, ?)
    `)
    const insertResult = db.prepare(`
      INSERT INTO send_results (
        batch_id, executor_id, executor_name, masked_email, plan_ids_json, status, error_code
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    db.exec('BEGIN IMMEDIATE')
    try {
      const created = insertBatch.run(
        profile,
        batch.createdAt,
        batch.totalMessages,
        batch.succeeded,
        batch.failed,
      )
      const batchId = Number(created.lastInsertRowid)
      for (const result of batch.results) {
        insertResult.run(
          batchId,
          result.executorId,
          result.executorName,
          result.maskedEmail,
          JSON.stringify(result.planIds),
          result.status,
          result.errorCode ?? '',
        )
      }
      db.exec('COMMIT')
      return batchId
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  listHistory(profile) {
    const db = this.#open()
    const batches = db.prepare(`
      SELECT id, created_at, total_messages, succeeded, failed
      FROM send_batches WHERE profile_key = ? ORDER BY created_at DESC, id DESC
    `).all(profile)
    const results = db.prepare(`
      SELECT executor_id, executor_name, masked_email, plan_ids_json, status, error_code
      FROM send_results WHERE batch_id = ? ORDER BY id
    `)
    return batches.map((batch) => ({
      id: batch.id,
      createdAt: batch.created_at,
      totalMessages: batch.total_messages,
      succeeded: batch.succeeded,
      failed: batch.failed,
      results: results.all(batch.id).map((result) => ({
        executorId: result.executor_id,
        executorName: result.executor_name,
        maskedEmail: result.masked_email,
        planIds: JSON.parse(result.plan_ids_json),
        status: result.status,
        errorCode: result.error_code,
      })),
    }))
  }

  clearHistory(profile) {
    const result = this.#open().prepare('DELETE FROM send_batches WHERE profile_key = ?').run(profile)
    return Number(result.changes)
  }
}
