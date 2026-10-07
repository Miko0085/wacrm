import { describe, it, expect } from 'vitest'
import { createFakeDb, type FakeDb } from '@/test-utils/fake-db'
import { validateFlowForActivation, findAutoAdvanceCycles } from '@/lib/flows/validate'
import { interpolateTemplate } from '@/lib/automations/engine'
// Plain ESM scripts (no TS types); allowJs infers them.
import {
  MARKERS,
  NAMES,
  PROTECTED_AUTOMATION_NAMES,
  WEBHOOK_BODY_TEMPLATE,
  assertFlowGraphSane,
  buildAutomationSpecs,
  buildFlowSpec,
  flattenSteps,
  withMarker,
} from '../../../scripts/lib/nika-seed-plan.mjs'
import { SeedConflictError, redact, runSeed } from '../../../scripts/lib/nika-seed-runner.mjs'

const ACC = 'acc-prod'
const COLD = PROTECTED_AUTOMATION_NAMES[0]

describe('nika seed plan', () => {
  const flow = buildFlowSpec({})
  const specs = buildAutomationSpecs({
    env: { NIKA_HANDOFF_WEBHOOK_URL: 'https://hooks.example.com/secret-path?token=abc' },
    flowId: 'flow-1',
    telegramConnectionId: 'tg-1',
  })

  it('every managed object carries its own unique marker in its description', () => {
    const all = [
      { marker: flow.marker, description: flow.row.description },
      ...specs.map((s: { marker: string; row: { description: string } }) => ({
        marker: s.marker,
        description: s.row.description,
      })),
    ]
    expect(new Set(all.map((a) => a.marker)).size).toBe(all.length)
    for (const a of all) expect(a.description).toContain(a.marker)
    expect(Object.values(MARKERS)).toHaveLength(5)
  })

  it('never plans a write to the protected production automation', () => {
    for (const spec of specs) expect(PROTECTED_AUTOMATION_NAMES).not.toContain(spec.row.name)
    expect(Object.values(NAMES)).not.toContain(COLD)
  })

  it('flow graph passes the REAL activation validator with no errors', () => {
    const issues = validateFlowForActivation(
      { ...flow.row, trigger_type: 'manual' } as never,
      flow.nodes as never,
    )
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
    expect(findAutoAdvanceCycles(flow.nodes as never)).toEqual([])
    expect(() => assertFlowGraphSane(flow.nodes, flow.row.entry_node_id)).not.toThrow()
  })

  it('media variant of the flow is valid too', () => {
    const withMedia = buildFlowSpec({
      NIKA_SELECTION_MEDIA_URL: 'https://cdn.example.com/brochure.pdf',
      NIKA_SELECTION_MEDIA_TYPE: 'document',
    })
    const issues = validateFlowForActivation(
      { ...withMedia.row, trigger_type: 'manual' } as never,
      withMedia.nodes as never,
    )
    expect(issues.filter((i) => i.severity === 'error')).toEqual([])
  })

  describe('assertFlowGraphSane rejects broken graphs before any write', () => {
    const n = (node_key: string, node_type: string, config: Record<string, unknown>) => ({
      node_key, node_type, config,
    })
    it('missing entry', () => {
      expect(() => assertFlowGraphSane([n('a', 'end', {})], 'start')).toThrow(/entry/)
    })
    it('dangling edge', () => {
      expect(() =>
        assertFlowGraphSane([n('start', 'start', { next_node_key: 'ghost' })], 'start'),
      ).toThrow(/missing node/)
    })
    it('auto-advancing cycle', () => {
      expect(() =>
        assertFlowGraphSane(
          [
            n('start', 'start', { next_node_key: 'a' }),
            n('a', 'send_message', { next_node_key: 'b' }),
            n('b', 'condition', { true_next: 'a', false_next: 'start' }),
          ],
          'start',
        ),
      ).toThrow(/cycle/)
    })
    it('duplicate keys', () => {
      expect(() =>
        assertFlowGraphSane([n('a', 'end', {}), n('a', 'end', {})], 'a'),
      ).toThrow(/duplicate/)
    })
  })

  it('Telegram handoff reads the durable event payload, not volatile AI vars', () => {
    const tg = specs.find((s: { key: string }) => s.key === 'telegram')!
    const msg = tg.steps[0].step_config.message as string
    expect(msg).toContain('{{event.reason}}')
    expect(msg).toContain('{{event.summary}}')
    expect(msg).not.toMatch(/vars\.ai_/)
    expect(tg.steps[0].step_config.parse_mode).toBeNull()
  })

  it('JSON templates stay valid JSON for hostile event text', () => {
    const hostile = 'He said "call me"\nplease \\   Привет 👋'
    const scope = {
      contactId: 'c-1',
      context: {
        conversation_id: 'conv-1',
        business_event_id: 'ev-1',
        business_event_type: 'human_handoff_requested',
        business_event_payload: { reason: hostile, summary: hostile },
      },
    }
    const hook = JSON.parse(interpolateTemplate(WEBHOOK_BODY_TEMPLATE, scope))
    expect(hook).toEqual({
      event_id: 'ev-1',
      event_type: 'human_handoff_requested',
      contact_id: 'c-1',
      conversation_id: 'conv-1',
      reason: hostile,
      summary: hostile,
    })
    for (const spec of specs) {
      for (const step of spec.steps) {
        const tpl = step.step_config.payload_template
        if (tpl) expect(() => JSON.parse(interpolateTemplate(tpl, scope))).not.toThrow()
      }
    }
  })

  it('flattenSteps emits parents before children with fresh ids', () => {
    let i = 0
    const rows = flattenSteps(
      [
        {
          step_type: 'condition',
          step_config: {},
          branches: { yes: [{ step_type: 'add_tag' }], no: [{ step_type: 'remove_tag' }] },
        },
      ],
      () => `id-${++i}`,
    )
    expect(rows.map((r: { id: string }) => r.id)).toEqual(['id-1', 'id-2', 'id-3'])
    expect(rows[1]).toMatchObject({ parent_step_id: 'id-1', branch: 'yes' })
    expect(rows[2]).toMatchObject({ parent_step_id: 'id-1', branch: 'no' })
  })

  it('withMarker is idempotent', () => {
    const once = withMarker('desc', MARKERS.flow)
    expect(withMarker(once, MARKERS.flow)).toBe(once)
  })
})

// ---------------------------------------------------------------------------
// Runner against a database double whose RPCs mimic the SQL contract of
// upsert_managed_flow / upsert_managed_automation (the SQL itself is verified
// against real Postgres in supabase/ci/orchestration-behavior.sql).
// ---------------------------------------------------------------------------
function seedDb(extra: Partial<Record<string, Record<string, unknown>[]>> = {}): FakeDb {
  let n = 0
  const db: FakeDb = createFakeDb(
    {
      account_memberships: [{ account_id: ACC, user_id: 'owner-1', role: 'owner', created_at: 1 }],
      telegram_connections: [{ id: 'tg-1', account_id: ACC, name: 'Ops', is_active: true, created_at: 1 }],
      flows: [],
      flow_runs: [],
      automations: [
        {
          id: 'cold-1',
          account_id: ACC,
          user_id: 'owner-1',
          name: COLD,
          description: 'production routing',
          trigger_type: 'keyword_match',
          trigger_config: { keywords: ['greece'] },
          is_active: true,
        },
      ],
      automation_steps: [{ id: 'cold-step', automation_id: 'cold-1', step_type: 'send_webhook' }],
      ...extra,
    },
    {
      rpc: {
        upsert_managed_flow: (a) => {
          const marker = a.p_marker as string
          const row = a.p_flow as Record<string, unknown>
          const existing = db.tables.flows.find(
            (f) => f.account_id === a.p_account_id && String(f.description ?? '').includes(marker),
          )
          if (existing) {
            if (db.tables.flow_runs.some((r) => r.flow_id === existing.id && r.status === 'active')) {
              throw new Error('has active run(s)')
            }
            Object.assign(existing, row, { nodes: a.p_nodes })
            return existing.id
          }
          const id = `flow-${++n}`
          db.tables.flows.push({ id, account_id: a.p_account_id, user_id: a.p_user_id, ...row, nodes: a.p_nodes })
          return id
        },
        upsert_managed_automation: (a) => {
          const marker = a.p_marker as string
          const row = a.p_automation as Record<string, unknown>
          const existing = db.tables.automations.find(
            (x) => x.account_id === a.p_account_id && String(x.description ?? '').includes(marker),
          )
          if (existing) {
            Object.assign(existing, row, { steps: a.p_steps })
            return existing.id
          }
          const id = `auto-${++n}`
          db.tables.automations.push({ id, account_id: a.p_account_id, user_id: a.p_user_id, ...row, steps: a.p_steps })
          return id
        },
      },
    },
  )
  return db
}

const run = (db: FakeDb, over: Partial<Parameters<typeof runSeed>[0]> = {}) => {
  const lines: string[] = []
  const promise = runSeed({
    db: db as never,
    accountId: ACC,
    apply: true,
    env: {},
    log: (m: string) => lines.push(m),
    ...over,
  })
  return { promise, lines }
}

describe('nika seed runner', () => {
  it('DRY RUN performs no writes and no RPC calls', async () => {
    const db = seedDb()
    const before = JSON.stringify(db.tables)
    const rpc = vi_spyRpc(db)
    const { promise } = run(db, { apply: false })
    const res = await promise
    expect(res.applied).toBe(false)
    expect(JSON.stringify(db.tables)).toBe(before)
    expect(rpc.calls).toHaveLength(0)
    expect(db.calls.filter((c) => c.kind !== 'select')).toHaveLength(0)
  })

  it('APPLY creates the managed Flow + automations and wires start_flow to the new flow id', async () => {
    const db = seedDb()
    const { promise } = run(db)
    const res = await promise
    expect(res.applied).toBe(true)
    expect(db.tables.flows).toHaveLength(1)
    const managedAutomations = db.tables.automations.filter((a) => String(a.description).includes('NIKA_MANAGED'))
    expect(managedAutomations).toHaveLength(3) // selection, call, telegram (no webhook env)
    const selection = managedAutomations.find((a) => a.name === NAMES.selection)!
    const steps = selection.steps as { step_type: string; step_config: { flow_id?: string } }[]
    expect(steps.find((s) => s.step_type === 'start_flow')!.step_config.flow_id).toBe(res.flowId)
  })

  it('is IDEMPOTENT: a second --apply updates in place and creates no duplicates', async () => {
    const db = seedDb()
    await run(db).promise
    const flows = db.tables.flows.map((f) => f.id)
    const autos = db.tables.automations.map((a) => a.id)
    await run(db).promise
    expect(db.tables.flows.map((f) => f.id)).toEqual(flows)
    expect(db.tables.automations.map((a) => a.id)).toEqual(autos)
  })

  it('NEVER modifies the protected "Cold WhatsApp — Positive Lead → amoCRM" automation', async () => {
    const db = seedDb()
    const before = JSON.stringify({
      a: db.tables.automations.find((a) => a.id === 'cold-1'),
      s: db.tables.automation_steps,
    })
    await run(db).promise
    await run(db).promise
    expect(
      JSON.stringify({
        a: db.tables.automations.find((a) => a.id === 'cold-1'),
        s: db.tables.automation_steps,
      }),
    ).toBe(before)
  })

  it('does NOT touch a user-created object that only shares a name (conflict, exit before any write)', async () => {
    const db = seedDb({
      flows: [
        { id: 'user-flow', account_id: ACC, name: NAMES.flow, description: 'hand-built by an admin', status: 'active' },
      ],
    })
    const { promise } = run(db)
    await expect(promise).rejects.toBeInstanceOf(SeedConflictError)
    expect(db.tables.flows).toEqual([
      { id: 'user-flow', account_id: ACC, name: NAMES.flow, description: 'hand-built by an admin', status: 'active' },
    ])
    expect(db.tables.automations).toHaveLength(1) // only the protected one — nothing was created
  })

  it('conflicts on an automation name are detected too, before the flow is written', async () => {
    const db = seedDb({
      automations: [
        { id: 'cold-1', account_id: ACC, name: COLD, description: 'x' },
        { id: 'user-auto', account_id: ACC, name: NAMES.call, description: 'mine' },
      ],
    })
    await expect(run(db).promise).rejects.toBeInstanceOf(SeedConflictError)
    expect(db.tables.flows).toHaveLength(0)
  })

  it('--adopt-existing stamps the marker on exactly the conflicting object, then updates it (no duplicate)', async () => {
    const db = seedDb({
      flows: [{ id: 'user-flow', account_id: ACC, name: NAMES.flow, description: 'legacy seed', status: 'active' }],
    })
    const { promise } = run(db, { adopt: true })
    const res = await promise
    expect(res.flowId).toBe('user-flow')
    expect(db.tables.flows).toHaveLength(1)
    expect(String(db.tables.flows[0].description)).toContain(MARKERS.flow)
  })

  it('refuses to replace a managed Flow that has active runs', async () => {
    const db = seedDb({
      flows: [{ id: 'f1', account_id: ACC, name: NAMES.flow, description: `x ${MARKERS.flow}` }],
      flow_runs: [{ id: 'r1', flow_id: 'f1', status: 'active' }],
    })
    await expect(run(db).promise).rejects.toThrow(/active run/)
    expect(db.calls.some((c) => c.kind === 'update')).toBe(false)
  })

  it('creates the Telegram automation INACTIVE when no connection exists', async () => {
    const db = seedDb({ telegram_connections: [] })
    await run(db).promise
    const tg = db.tables.automations.find((a) => a.name === NAMES.telegram)!
    expect(tg.is_active).toBe(false)
  })

  it('creates the webhook automation only when NIKA_HANDOFF_WEBHOOK_URL is set', async () => {
    const without = seedDb()
    await run(without).promise
    expect(without.tables.automations.some((a) => a.name === NAMES.webhook)).toBe(false)

    const withHook = seedDb()
    await run(withHook, { env: { NIKA_HANDOFF_WEBHOOK_URL: 'https://hooks.example.com/x' } }).promise
    expect(withHook.tables.automations.some((a) => a.name === NAMES.webhook)).toBe(true)
  })

  it('never prints webhook URLs or header values', async () => {
    const db = seedDb()
    const { promise, lines } = run(db, {
      env: {
        NIKA_HANDOFF_WEBHOOK_URL: 'https://hooks.example.com/super-secret-path?token=TOPSECRET',
        NIKA_HANDOFF_WEBHOOK_HEADERS_JSON: '{"Authorization":"Bearer TOPSECRET"}',
      },
    })
    await promise
    const out = lines.join('\n')
    expect(out).not.toContain('TOPSECRET')
    expect(out).not.toContain('super-secret-path')
    expect(out).toContain('hooks.example.com')
  })

  it('requires an owner: no env override and no admin => clear error before writing', async () => {
    const db = seedDb({ account_memberships: [] })
    db.tables.automations = []
    await expect(run(db).promise).rejects.toThrow(/owner\/admin/)
    expect(db.tables.flows).toHaveLength(0)
  })

  it('redact() masks headers and URLs', () => {
    expect(redact({ headers: { A: 'b' }, url: 'https://x.test/p?q=1' })).toEqual({
      headers: { A: '[redacted]' },
      url: 'https://x.test/[redacted]',
    })
  })
})

function vi_spyRpc(db: FakeDb) {
  const calls: string[] = []
  const orig = db.rpc.bind(db)
  db.rpc = (async (name: string, args?: Record<string, unknown>) => {
    calls.push(name)
    return orig(name, args)
  }) as typeof db.rpc
  return { calls }
}
