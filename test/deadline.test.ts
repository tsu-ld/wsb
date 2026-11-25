import { expect, test } from 'bun:test'
import { latestReset, plausible } from '../src/deadline.ts'

test('elapsed windows do not block; a missing reset on an exhausted window is not guessed', () => {
  expect(latestReset([90, 120, 130], 100)).toBe(130)
  expect(latestReset([90], 100)).toBeUndefined()
  expect(latestReset([undefined, 150], 100)).toBeUndefined()
  expect(latestReset([null, 150], 100)).toBeUndefined()
})

test('a future monthly reset is allowed; microseconds mistaken for milliseconds are not', () => {
  const now = Date.now()
  const month = 31 * 86_400_000
  expect(plausible(now + month, now)).toBe(true)
  expect(plausible((now + month) * 1000, now)).toBe(false)
})

test('a zero reset voids the whole list even beside a future one', () => {
  const now = Date.now()
  expect(latestReset([0, now + 3_600_000], now)).toBeUndefined()
})
