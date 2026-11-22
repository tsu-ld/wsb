import { expect, test } from 'bun:test'
import { bar, clock, compact, countdown, providerLabel, remaining } from '../src/hold.ts'

const at = (day, hour, minute) => new Date(2026, 10, day, hour, minute, 0, 0).getTime()

test('remaining counts up to the deadline in whole seconds and never goes negative', () => {
  expect(remaining(10_000, 0)).toBe(10)
  expect(remaining(10_001, 0)).toBe(11)
  expect(remaining(10_000, 5000)).toBe(5)
  expect(remaining(10_000, 10_000)).toBe(0)
  expect(remaining(10_000, 12_000)).toBe(0)
})

test('countdown shows minutes and seconds, then hours, then days', () => {
  expect(countdown(0)).toBe('0m 00s')
  expect(countdown(59)).toBe('0m 59s')
  expect(countdown(60)).toBe('1m 00s')
  expect(countdown(1344)).toBe('22m 24s')
  expect(countdown(3599)).toBe('59m 59s')
  expect(countdown(3600)).toBe('1h 00m')
  expect(countdown(5400)).toBe('1h 30m')
  expect(countdown(86_400)).toBe('1d 0h')
  expect(countdown(90_000)).toBe('1d 1h')
})

test('compact is the footer form and keeps the next unit for long waits', () => {
  expect(compact(0)).toBe('0s')
  expect(compact(42)).toBe('42s')
  expect(compact(60)).toBe('1m')
  expect(compact(3599)).toBe('59m')
  expect(compact(3600)).toBe('1h 00m')
  expect(compact(5400)).toBe('1h 30m')
  expect(compact(86_400)).toBe('1d')
  expect(compact(180_000)).toBe('2d')
})

test('clock prints the local reset time, and the weekday once it is not today', () => {
  const until = at(22, 3, 17)
  expect(clock(until, at(22, 1, 0))).toBe('03:17')
  expect(clock(until, at(21, 23, 59))).toBe('03:17')
  expect(clock(at(24, 1, 0), at(22, 12, 0))).toBe('Tue 01:00')
  expect(clock(at(23, 22, 5), at(22, 12, 0))).toBe('Mon 22:05')
})

test('bar fills the share of the wait that has already passed', () => {
  expect(bar(24, 0, 100, 0)).toEqual({ filled: 0, empty: 24 })
  expect(bar(24, 0, 100, 50)).toEqual({ filled: 12, empty: 12 })
  expect(bar(24, 0, 100, 100)).toEqual({ filled: 24, empty: 0 })
  expect(bar(24, 0, 100, 250)).toEqual({ filled: 24, empty: 0 })
  expect(bar(24, 0, 100, -5)).toEqual({ filled: 0, empty: 24 })
  expect(bar(24, 5, 5, 10)).toEqual({ filled: 24, empty: 0 })
  expect(bar(0, 0, 100, 50)).toEqual({ filled: 0, empty: 0 })
  expect(bar(24.9, 0, 3, 1)).toEqual({ filled: 8, empty: 16 })
})

test('providerLabel names the subscription behind the provider id', () => {
  expect(providerLabel('anthropic')).toBe('Claude Max')
  expect(providerLabel('openai')).toBe('ChatGPT')
  expect(providerLabel('opencode-go')).toBe('OpenCode Go')
  expect(providerLabel('local')).toBeUndefined()
})
