/**
 * Minimal in-memory stand-in for the slice of the supabase-js query builder
 * that the orchestration workers use. It is deliberately small and strict:
 * an unsupported filter throws instead of silently matching everything, so a
 * test can never go green because the fake ignored a condition.
 *
 * Supported: select / insert / update / delete / upsert-free flows,
 * eq neq lt lte gt gte in is or(...) order limit, maybeSingle / single,
 * head count selects, and `rpc` handlers registered by the test.
 */
type Row = Record<string, unknown>
type Pred = (row: Row) => boolean

export interface FakeDbOptions {
  rpc?: Record<string, (args: Record<string, unknown>) => unknown>
  /** Called on every write so tests can simulate a concurrent writer. */
  onWrite?: (table: string, kind: 'insert' | 'update' | 'delete') => void
}

export interface FakeDb {
  tables: Record<string, Row[]>
  from(table: string): Builder
  rpc(name: string, args?: Record<string, unknown>): Promise<{ data: unknown; error: unknown }>
  calls: { table: string; kind: string; payload?: unknown }[]
}

function cmp(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  return (a as string | number) < (b as string | number) ? -1 : 1
}

function parseOrClause(clause: string): Pred {
  const preds = clause.split(',').map((part): Pred => {
    const [col, op, ...rest] = part.split('.')
    const value = rest.join('.')
    switch (op) {
      case 'is':
        if (value !== 'null') throw new Error(`fake-db: unsupported is.${value}`)
        return (r) => r[col] === null || r[col] === undefined
      case 'lt':
        return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value) < 0
      case 'lte':
        return (r) => r[col] !== null && r[col] !== undefined && cmp(r[col], value) <= 0
      case 'eq':
        return (r) => String(r[col]) === value
      default:
        throw new Error(`fake-db: unsupported or() operator "${op}"`)
    }
  })
  return (row) => preds.some((p) => p(row))
}

class Builder implements PromiseLike<{ data: unknown; error: unknown; count?: number | null }> {
  private kind: 'select' | 'insert' | 'update' | 'delete' = 'select'
  private preds: Pred[] = []
  private payload: Row | Row[] | null = null
  private orderBy: { col: string; asc: boolean }[] = []
  private max: number | null = null
  private returning = false
  private singleMode: 'one' | 'maybe' | null = null
  private head = false

  constructor(
    private db: FakeDb,
    private table: string,
    private opts: FakeDbOptions,
  ) {}

  select(_cols?: string, options?: { count?: string; head?: boolean }) {
    if (this.kind === 'select') {
      this.head = Boolean(options?.head)
    } else {
      this.returning = true
    }
    return this
  }
  insert(payload: Row | Row[]) {
    this.kind = 'insert'
    this.payload = payload
    return this
  }
  update(payload: Row) {
    this.kind = 'update'
    this.payload = payload
    return this
  }
  delete() {
    this.kind = 'delete'
    return this
  }
  eq(col: string, value: unknown) {
    this.preds.push((r) => r[col] === value)
    return this
  }
  neq(col: string, value: unknown) {
    this.preds.push((r) => r[col] !== value)
    return this
  }
  lt(col: string, value: unknown) {
    this.preds.push((r) => r[col] != null && cmp(r[col], value) < 0)
    return this
  }
  lte(col: string, value: unknown) {
    this.preds.push((r) => r[col] != null && cmp(r[col], value) <= 0)
    return this
  }
  gt(col: string, value: unknown) {
    this.preds.push((r) => r[col] != null && cmp(r[col], value) > 0)
    return this
  }
  gte(col: string, value: unknown) {
    this.preds.push((r) => r[col] != null && cmp(r[col], value) >= 0)
    return this
  }
  in(col: string, values: unknown[]) {
    this.preds.push((r) => values.includes(r[col]))
    return this
  }
  is(col: string, value: unknown) {
    this.preds.push((r) => (value === null ? r[col] == null : r[col] === value))
    return this
  }
  or(clause: string) {
    this.preds.push(parseOrClause(clause))
    return this
  }
  order(col: string, o?: { ascending?: boolean }) {
    this.orderBy.push({ col, asc: o?.ascending !== false })
    return this
  }
  limit(n: number) {
    this.max = n
    return this
  }
  maybeSingle() {
    this.singleMode = 'maybe'
    return this
  }
  // Mirrors supabase-js: `.single()` errors on 0 rows.
  single() {
    this.singleMode = 'one'
    return this
  }

  private run(): { data: unknown; error: unknown; count?: number | null } {
    const rows = (this.db.tables[this.table] ??= [])
    this.db.calls.push({ table: this.table, kind: this.kind, payload: this.payload ?? undefined })

    if (this.kind === 'insert') {
      const incoming = Array.isArray(this.payload) ? this.payload : [this.payload as Row]
      const created = incoming.map((r) => ({
        id: r.id ?? `${this.table}-${rows.length + 1}`,
        ...r,
      }))
      rows.push(...created)
      this.opts.onWrite?.(this.table, 'insert')
      return this.shape(created)
    }

    let matched = rows.filter((r) => this.preds.every((p) => p(r)))
    for (const { col, asc } of [...this.orderBy].reverse()) {
      matched = [...matched].sort((a, b) => (asc ? 1 : -1) * cmp(a[col], b[col]))
    }
    if (this.max !== null) matched = matched.slice(0, this.max)

    if (this.kind === 'update') {
      for (const r of matched) Object.assign(r, this.payload as Row)
      this.opts.onWrite?.(this.table, 'update')
      return this.shape(matched)
    }
    if (this.kind === 'delete') {
      this.db.tables[this.table] = rows.filter((r) => !matched.includes(r))
      this.opts.onWrite?.(this.table, 'delete')
      return this.shape(matched)
    }
    if (this.head) return { data: null, error: null, count: matched.length }
    return this.shape(matched)
  }

  private shape(rows: Row[]) {
    const out = this.kind === 'select' || this.returning ? rows.map((r) => ({ ...r })) : null
    if (this.singleMode) {
      if (!out || out.length === 0) {
        return this.singleMode === 'one'
          ? { data: null, error: { message: 'no rows' } }
          : { data: null, error: null }
      }
      return { data: out[0], error: null }
    }
    return { data: out, error: null }
  }

  then<T1 = unknown, T2 = never>(
    onFulfilled?: ((v: { data: unknown; error: unknown; count?: number | null }) => T1 | PromiseLike<T1>) | null,
    onRejected?: ((r: unknown) => T2 | PromiseLike<T2>) | null,
  ): PromiseLike<T1 | T2> {
    try {
      return Promise.resolve(this.run()).then(onFulfilled, onRejected)
    } catch (e) {
      return Promise.reject(e).then(onFulfilled, onRejected)
    }
  }
}

export function createFakeDb(
  tables: Record<string, Row[]> = {},
  opts: FakeDbOptions = {},
): FakeDb {
  const db: FakeDb = {
    tables,
    calls: [],
    from(table: string) {
      return new Builder(db, table, opts)
    },
    async rpc(name, args = {}) {
      const handler = opts.rpc?.[name]
      if (!handler) return { data: null, error: null }
      return { data: handler(args), error: null }
    },
  }
  return db
}
