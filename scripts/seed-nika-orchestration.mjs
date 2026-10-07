#!/usr/bin/env node
//
// Idempotent seed for the Nika orchestration objects.
//
//   node scripts/seed-nika-orchestration.mjs                          # dry run (default)
//   node scripts/seed-nika-orchestration.mjs --apply                  # write
//   node scripts/seed-nika-orchestration.mjs --apply --adopt-existing # take over same-name objects
//
// Safety model:
//   * dry run unless --apply is passed; NIKA_WACRM_ACCOUNT_ID is mandatory
//     (there is no default account);
//   * only objects carrying their [NIKA_MANAGED:<key>] marker are ever updated.
//     An object that merely shares a NAME is reported as a CONFLICT and nothing
//     is written, unless --adopt-existing is given (which only stamps the
//     marker onto that exact object);
//   * every Flow / Automation replacement is ONE database transaction
//     (upsert_managed_flow / upsert_managed_automation, migration 058), so live
//     traffic sees the old graph or the new one — never a half-replaced one;
//   * a managed Flow with active runs is never replaced;
//   * the "Cold WhatsApp — Positive Lead → amoCRM" automation is never written.

import { createClient } from '@supabase/supabase-js'
import { SeedConflictError, runSeed } from './lib/nika-seed-runner.mjs'

const APPLY = process.argv.includes('--apply')
const ADOPT = process.argv.includes('--adopt-existing')
const ACCOUNT_ID = (process.env.NIKA_WACRM_ACCOUNT_ID || '').trim()
const SUPABASE_URL =
  process.env.SUPABASE_INTERNAL_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error(
    'Missing SUPABASE_INTERNAL_URL/NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY',
  )
  process.exit(1)
}

if (!ACCOUNT_ID) {
  console.error('NIKA_WACRM_ACCOUNT_ID is required. Refusing to guess a production account.')
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false, autoRefreshToken: false },
})

runSeed({ db, accountId: ACCOUNT_ID, apply: APPLY, adopt: ADOPT }).catch((err) => {
  if (err instanceof SeedConflictError) {
    console.error(
      '\nCONFLICT: these objects already exist with a managed name but WITHOUT the managed marker:',
    )
    for (const c of err.conflicts) console.error(`  - ${c.kind} "${c.name}" (${c.id})`)
    console.error(
      '\nNothing was written. They were not created by this seed, so they will not be modified.\n' +
        'Review them, then either rename/delete them yourself, or re-run with --apply --adopt-existing\n' +
        'to let the seed take ownership of exactly these objects.',
    )
    process.exit(2)
  }
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})
