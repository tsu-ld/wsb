import { expect, test } from 'bun:test'
import { lastBlockingReset, retryDecision } from '../src/policy.ts'

test('elapsed windows do not block; a missing reset on an exhausted window is not guessed', () => {
  expect(lastBlockingReset([90, 120, 130], 100)).toBe(130)
  expect(lastBlockingReset([90], 100)).toBeUndefined()
  expect(lastBlockingReset([undefined, 150], 100)).toBeUndefined()
  expect(lastBlockingReset([null, 150], 100)).toBeUndefined()
})

test('a future monthly reset is allowed; microseconds mistaken for milliseconds are not', () => {
  const now = Date.now()
  const month = 31 * 86_400_000
  expect(retryDecision(now + month, now)).toEqual({ retry: true, delay: month })
  expect(retryDecision((now + month) * 1000, now)).toBeUndefined()
})
