import { expect, it } from 'vitest'
import { LatestUpdate } from './latest-update'

it('keeps only the newest pending gesture update while an operation is in flight', async () => {
  let release: (() => void) | undefined
  const calls: number[] = []
  const queue = new LatestUpdate<number>(async value => { calls.push(value); if (value === 1) await new Promise<void>(resolve => { release = resolve }) })
  const finished = queue.push(1)
  for (let value = 2; value <= 100; value++) void queue.push(value)
  expect(calls).toEqual([1]); release?.(); await finished
  expect(calls).toEqual([1, 100])
  await queue.push(101); expect(calls).toEqual([1, 100, 101])
})

it('does not lose a final update queued between drain completion and promise settlement', async () => {
  const calls: number[] = []
  const queue = new LatestUpdate<number>(value => { calls.push(value); return Promise.resolve() })
  const first = queue.push(1)
  await Promise.resolve()
  const last = queue.push(2)
  await Promise.all([first, last])
  expect(calls).toEqual([1, 2])
})
