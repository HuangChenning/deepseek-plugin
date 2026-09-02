/**
 * 本机 SQLite 缓存。
 *
 * 库是每台机器自己的：落在 DSH 的 storages 目录（工作区之外），不进 Git，也不做
 * 跨机同步。**懒创建**——插件加载时不建库，只有真正要落盘（第一次查询）时才建
 * 文件和表，因此没查过的机器上不该存在这个文件。
 *
 * 依赖 Node 24 内置的 node:sqlite，不引入外部依赖。
 *
 * 窗口语义与 MES 一致（已实测）：`--start-date X --end-date Y` 是完全包含，只返回
 * `startDate >= X 且 endDate <= Y` 的计划。这条性质给出窗口单调性——大窗口的结果
 * 包含其中任何小窗口的结果——所以缓存可以用一个已同步的大窗口精确服务小窗口查询，
 * 本地只要复现同样的两个不等式。
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export const DB_PATH = join(homedir(), '.dsh', 'storages', 'mes-plan-list', 'plans.db')

/**
 * 表结构版本。缓存是可重建的派生数据，所以版本不匹配时直接重建空表，让下次查询
 * 重新同步——比写迁移、或让旧行带着空字段参与筛选都更简单也更不容易出错。
 */
const SCHEMA_VERSION = 3

const SCHEMA = `
CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  status INTEGER,
  check_type INTEGER,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plans_window ON plans (start_date, end_date);
CREATE TABLE IF NOT EXISTS windows (
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (start_date, end_date)
);
CREATE TABLE IF NOT EXISTS work_hours (
  id INTEGER PRIMARY KEY,
  plan_id INTEGER,
  work_date TEXT NOT NULL,
  hours REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS work_hours_window ON work_hours (work_date);
CREATE TABLE IF NOT EXISTS hour_windows (
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (start_date, end_date)
);
`

/**
 * 归一成 `YYYY-MM-DD HH:mm:ss`，这样字典序比较就等价于时间序比较。
 *
 * 时间部分**不能**丢：MES 把 `--end-date 2026-07-31` 当作 `2026-07-31 00:00:00`，
 * 所以 endDate 为 `2026-07-31 18:00:00` 的计划会被它排除。截断到日期再比较会把
 * 这些多算进来——实测某个窄窗口本地 11 条、MES 只有 6 条，差的正是这一类。
 */
function stamp(value) {
  const text = String(value ?? '').trim()
  return text.length <= 10 ? `${text} 00:00:00` : text
}

/** 窗口边界按 MES 的解释展开成当天零点。 */
function boundary(date) {
  return `${String(date ?? '').slice(0, 10)} 00:00:00`
}

export class PlanStore {
  #db

  constructor(path = DB_PATH) {
    this.path = path
  }

  /** 首次真正需要落盘时才建库建表。 */
  #open() {
    if (this.#db === undefined) {
      mkdirSync(dirname(this.path), { recursive: true })
      this.#db = new DatabaseSync(this.path)
      const [{ user_version: version }] = this.#db.prepare('PRAGMA user_version').all()
      if (version !== SCHEMA_VERSION) {
        // 旧结构直接丢弃重建：缓存可以从 MES 重新取回，迁移的复杂度不值得。
        this.#db.exec(`DROP TABLE IF EXISTS plans; DROP TABLE IF EXISTS windows;
                       DROP TABLE IF EXISTS work_hours; DROP TABLE IF EXISTS hour_windows;`)
        this.#db.exec(SCHEMA)
        this.#db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
      } else {
        this.#db.exec(SCHEMA)
      }
    }
    return this.#db
  }

  close() {
    this.#db?.close()
    this.#db = undefined
  }

  /**
   * 找出能覆盖该窗口的最近一次同步时间，没有则返回 undefined。
   * 覆盖 = 已同步窗口比请求窗口更宽或相等。
   */
  findCoveringSync({ startDate, endDate }) {
    const row = this.#open()
      .prepare(`SELECT synced_at FROM windows
                WHERE start_date <= ? AND end_date >= ?
                ORDER BY synced_at DESC LIMIT 1`)
      .get(startDate, endDate)
    return row === undefined ? undefined : row.synced_at
  }

  /**
   * 把要同步的窗口扩展到覆盖所有已缓存过的范围。
   *
   * 幽灵行的根源不是「做了增量」，而是「同步窗口比缓存过的范围窄」——窄窗口同步
   * 只能清掉它自己窗口内已被 MES 删除的计划。取当前窗口与历史所有已同步窗口的
   * 并集来同步，正确性上就等价于全量，但只有在真正缓存过大范围时才付出全量的
   * 代价；用户也不必再判断「这次该增量还是全量」。范围大到不想要了就清空缓存。
   */
  coveringWindow({ startDate, endDate }) {
    const row = this.#open().prepare('SELECT MIN(start_date) AS s, MAX(end_date) AS e FROM windows').get()
    if (row === undefined || row.s === null || row.s === undefined) return { startDate, endDate }
    return {
      startDate: row.s < startDate ? row.s : startDate,
      endDate: row.e > endDate ? row.e : endDate,
    }
  }

  /**
   * 报工缓存。与计划分开：报工比计划多一个数量级（全年 3.4 万条 vs 950 条），
   * 拉一次全年要几分钟，所以它按需加载，不跟着计划同步走。
   *
   * 报工是单日事件，MES 的 `--from/--to` 按 start 的日期闭区间过滤（已实测），
   * 因此子窗口的报工天然是父窗口的子集，可以和计划一样用「已同步窗口覆盖当前
   * 窗口」来判断能否走缓存。
   */
  findCoveringHours({ startDate, endDate }) {
    const row = this.#open()
      .prepare(`SELECT synced_at FROM hour_windows
                WHERE start_date <= ? AND end_date >= ?
                ORDER BY synced_at DESC LIMIT 1`)
      .get(startDate, endDate)
    return row === undefined ? undefined : row.synced_at
  }

  /** 窗口内每个计划的报工工时合计，返回 { [planId]: hours }。 */
  readHours({ startDate, endDate }) {
    const rows = this.#open()
      .prepare(`SELECT plan_id, SUM(hours) AS total FROM work_hours
                WHERE plan_id IS NOT NULL AND work_date >= ? AND work_date <= ?
                GROUP BY plan_id`)
      .all(String(startDate).slice(0, 10), String(endDate).slice(0, 10))
    return Object.fromEntries(rows.map((row) => [row.plan_id, row.total]))
  }

  /** 写入一个窗口的报工明细，语义与 writeWindow 相同（先清窗口再写）。 */
  writeHours({ startDate, endDate }, records, syncedAt = new Date().toISOString()) {
    const db = this.#open()
    db.exec('BEGIN')
    try {
      db.prepare('DELETE FROM work_hours WHERE work_date >= ? AND work_date <= ?')
        .run(String(startDate).slice(0, 10), String(endDate).slice(0, 10))
      const insert = db.prepare('INSERT OR REPLACE INTO work_hours (id, plan_id, work_date, hours) VALUES (?, ?, ?, ?)')
      for (const record of records) {
        if (!Number.isInteger(record.id)) continue
        insert.run(record.id, record.planId ?? null, record.workDate, record.hours)
      }
      db.prepare(`INSERT INTO hour_windows (start_date, end_date, synced_at) VALUES (?, ?, ?)
                  ON CONFLICT(start_date, end_date) DO UPDATE SET synced_at = excluded.synced_at`)
        .run(startDate, endDate, syncedAt)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return syncedAt
  }

  /** 缓存概况：覆盖的日期范围、计划条数、最近一次同步时间。 */
  summary() {
    const db = this.#open()
    const span = db.prepare('SELECT MIN(start_date) AS s, MAX(end_date) AS e, MAX(synced_at) AS at FROM windows').get()
    return {
      count: db.prepare('SELECT COUNT(*) AS c FROM plans').get().c,
      startDate: span?.s == null ? '' : String(span.s).slice(0, 10),
      endDate: span?.e == null ? '' : String(span.e).slice(0, 10),
      syncedAt: span?.at == null ? '' : span.at,
    }
  }

  /** 清空缓存，把同步范围重置回空——例如不再关心很早以前的数据。 */
  clear() {
    const db = this.#open()
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM plans')
      db.exec('DELETE FROM windows')
      db.exec('DELETE FROM work_hours')
      db.exec('DELETE FROM hour_windows')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 按 MES 的窗口语义从本地取计划。
   *
   * 状态和类型都支持多选，且都在本地完成：MES 的 `--status` 与 `--check-type`
   * 只接受单值（实测 `--status 2,3` 返回 0 条），但缓存里存的是窗口全集，因此
   * 任意组合都能筛。空数组表示不限。
   */
  readPlans({ startDate, endDate, statuses = [], checkTypes = [] }) {
    const clauses = ['start_date >= ?', 'end_date <= ?']
    const params = [boundary(startDate), boundary(endDate)]
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(', ')})`)
      params.push(...statuses.map(Number))
    }
    if (checkTypes.length > 0) {
      clauses.push(`check_type IN (${checkTypes.map(() => '?').join(', ')})`)
      params.push(...checkTypes.map(Number))
    }
    return this.#open()
      .prepare(`SELECT payload FROM plans WHERE ${clauses.join(' AND ')} ORDER BY start_date, id`)
      .all(...params)
      .map((row) => JSON.parse(row.payload))
  }

  /**
   * 写入一次全状态同步的结果。
   *
   * 同一事务里做三件事：删掉该窗口内本次未返回的行（MES 侧已删除的幽灵行——
   * MES 对该窗口的返回就是全集，所以这个判断是精确的）、upsert 本次返回的行、
   * 记录窗口的同步时间。
   */
  writeWindow({ startDate, endDate }, plans, syncedAt = new Date().toISOString()) {
    const db = this.#open()
    const keep = plans.map((plan) => plan.id).filter((id) => Number.isInteger(id))
    db.exec('BEGIN')
    try {
      const placeholders = keep.map(() => '?').join(', ')
      db.prepare(`DELETE FROM plans WHERE start_date >= ? AND end_date <= ?
                  ${keep.length === 0 ? '' : `AND id NOT IN (${placeholders})`}`)
        .run(boundary(startDate), boundary(endDate), ...keep)
      const upsert = db.prepare(`INSERT INTO plans (id, start_date, end_date, status, check_type, payload)
                                 VALUES (?, ?, ?, ?, ?, ?)
                                 ON CONFLICT(id) DO UPDATE SET
                                   start_date = excluded.start_date,
                                   end_date = excluded.end_date,
                                   status = excluded.status,
                                   check_type = excluded.check_type,
                                   payload = excluded.payload`)
      for (const plan of plans) {
        if (!Number.isInteger(plan.id)) continue
        upsert.run(
          plan.id, stamp(plan.startDate), stamp(plan.endDate),
          Number(plan.status) || 0, Number.isInteger(plan.checkType) ? plan.checkType : null,
          JSON.stringify(plan),
        )
      }
      db.prepare(`INSERT INTO windows (start_date, end_date, synced_at) VALUES (?, ?, ?)
                  ON CONFLICT(start_date, end_date) DO UPDATE SET synced_at = excluded.synced_at`)
        .run(startDate, endDate, syncedAt)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return syncedAt
  }
}
