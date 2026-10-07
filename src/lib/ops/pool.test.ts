import { describe, it, expect } from 'vitest'
import { runBounded } from './pool'

const tick = () => new Promise((r) => setTimeout(r, 1))

describe('runBounded', () => {
  it('never runs more than `concurrency` workers at once', async () => {
    let active = 0
    let peak = 0
    const { results } = await runBounded(Array.from({ length: 20 }, (_, i) => i), 3, async (n) => {
      active += 1
      peak = Math.max(peak, active)
      await tick()
      active -= 1
      return n * 2
    })
    expect(peak).toBe(3)
    expect(results).toHaveLength(20)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('isolates a throwing worker from the rest of the batch', async () => {
    const { results } = await runBounded([1, 2, 3], 2, async (n) => {
      if (n === 2) throw new Error('boom')
      return n
    })
    expect(results.filter((r) => r.ok)).toHaveLength(2)
    expect(results.filter((r) => !r.ok)).toHaveLength(1)
  })

  it('stops STARTING new items once the deadline passes, but lets running ones finish', async () => {
    let clock = 0
    const started: number[] = []
    const out = await runBounded(
      [1, 2, 3, 4, 5, 6],
      2,
      async (n) => {
        started.push(n)
        clock += 100 // each item "takes" 100ms of the fake clock
        await tick()
        return n
      },
      { deadline: 250, now: () => clock },
    )
    expect(started.length).toBeLessThan(6)
    expect(out.skipped).toBe(6 - started.length)
    expect(out.results).toHaveLength(started.length)
  })

  it('handles an empty batch', async () => {
    const out = await runBounded([], 4, async () => 1)
    expect(out).toEqual({ results: [], skipped: 0 })
  })
})
