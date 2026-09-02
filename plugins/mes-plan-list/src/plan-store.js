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
const SCHEMA_VERSION = 4

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
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
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
        this.#db.exec(`DROP TABLE IF EXISTS plans; DROP TABLE IF EXISTS windows; DROP TABLE IF EXISTS meta;
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

  /** 上次全量同步的时间；从未同步过则是 undefined。 */
  lastSync() {
    const row = this.#open().prepare("SELECT value FROM meta WHERE key = 'plans_synced_at'").get()
    return row === undefined ? undefined : row.value
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

  /** 缓存概况：计划条数与上次全量同步时间。 */
  summary() {
    return {
      count: this.#open().prepare('SELECT COUNT(*) AS c FROM plans').get().c,
      syncedAt: this.lastSync() ?? '',
    }
  }

  /** 清空缓存，把同步范围重置回空——例如不再关心很早以前的数据。 */
  clear() {
    const db = this.#open()
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM plans')
      db.exec('DELETE FROM meta')
      db.exec('DELETE FROM work_hours')
      db.exec('DELETE FROM hour_windows')
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /**
   * 取出与窗口**有交集**的计划。
   *
   * 这与 MES 自己的过滤语义不同：`--start-date/--end-date` 只返回整个落在窗口内
   * 的计划，于是一个 5 月开始、8 月结束的计划不会出现在 8 月的查询里——而使用者
   * 期望看到它。所以本地按区间重叠筛：计划开始 <= 窗口结束，且计划结束 >= 窗口
   * 开始。比较按日粒度，当天开始或当天结束的计划都算命中。
   *
   * 这也意味着同步必须比查询窗口取得更宽，否则跨界的计划根本不在库里；
   * 见 coveringWindow 与 LOOKBACK_DAYS。
   *
   * 状态为「结束」（2）的计划一律不返回，界面上也没有这个筛选项。
   *
   * 其余状态和类型都支持多选，同样在本地完成：MES 的 `--status` 与 `--check-type`
   * 只接受单值（实测 `--status 2,3` 返回 0 条）。空数组表示不限。
   */
  readPlans({ startDate, endDate, statuses = [], checkTypes = [] }) {
    // 已结束的计划不在关注范围内，始终排除——界面上也没有对应的筛选项。
    const clauses = ['substr(start_date, 1, 10) <= ?', 'substr(end_date, 1, 10) >= ?', 'status IS NOT 2']
    const params = [String(endDate).slice(0, 10), String(startDate).slice(0, 10)]
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
   * 用一次全量结果整体替换计划表。
   *
   * 全量同步让删除检测变得平凡：MES 这次没给的计划就是不存在的，直接清表重写即可，
   * 不需要按窗口推断哪些行成了幽灵。这也是选择全量而非按窗口增量的主要理由——
   * 窗口方案要靠「同步范围比查询范围更宽」的启发式才能不漏计划，边界很难说清。
   */
  replaceAllPlans(plans, syncedAt = new Date().toISOString()) {
    const db = this.#open()
    db.exec('BEGIN')
    try {
      db.exec('DELETE FROM plans')
      const insert = db.prepare(`INSERT OR REPLACE INTO plans (id, start_date, end_date, status, check_type, payload)
                                 VALUES (?, ?, ?, ?, ?, ?)`)
      for (const plan of plans) {
        if (!Number.isInteger(plan.id)) continue
        insert.run(
          plan.id, stamp(plan.startDate), stamp(plan.endDate),
          Number(plan.status) || 0, Number.isInteger(plan.checkType) ? plan.checkType : null,
          JSON.stringify(plan),
        )
      }
      db.prepare("INSERT INTO meta (key, value) VALUES ('plans_synced_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(syncedAt)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
    return syncedAt
  }
}
