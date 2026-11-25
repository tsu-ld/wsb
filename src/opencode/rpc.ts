import { Rpc } from '@opencode/plugin/rpc'
import type { Hold } from '../format.ts'

export interface HoldState extends Hold {
  readonly sessionID: string
}

export type Reason = Readonly<{ at: number; reason: string }>

const hold = {
  type: 'object',
  properties: {
    until: { type: 'number' },
    since: { type: 'number' },
    providerID: { type: 'string' },
    model: { type: 'string' },
  },
  required: ['until', 'since', 'providerID', 'model'],
  additionalProperties: false,
} as const

const state = {
  type: 'object',
  properties: {
    sessionID: { type: 'string' },
    ...hold.properties,
  },
  required: ['sessionID', ...hold.required],
  additionalProperties: false,
} as const

const reason = {
  type: 'object',
  properties: {
    at: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['at', 'reason'],
  additionalProperties: false,
} as const

const session = {
  type: 'object',
  properties: { sessionID: { type: 'string' } },
  required: ['sessionID'],
  additionalProperties: false,
} as const

export const Definition = Rpc.define({
  id: 'wsb.hold',
  methods: {
    get: {
      input: session,
      output: { anyOf: [{ type: 'null' }, state] },
    },
    why: {
      input: session,
      output: { anyOf: [{ type: 'null' }, reason] },
    },
  },
  events: {
    changed: {
      schema: {
        type: 'object',
        properties: { sessionID: { type: 'string' } },
        required: ['sessionID'],
        additionalProperties: false,
      },
    },
  },
})

const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value)

export function changedSession(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('sessionID' in value)) {
    return undefined
  }
  return typeof value.sessionID === 'string' ? value.sessionID : undefined
}

export function isReason(value: unknown): value is Reason {
  if (!value || typeof value !== 'object') {
    return false
  }
  return 'at' in value && number(value.at) && 'reason' in value && typeof value.reason === 'string'
}

export function isHoldState(value: unknown): value is HoldState {
  if (!value || typeof value !== 'object') {
    return false
  }
  return (
    'sessionID' in value &&
    typeof value.sessionID === 'string' &&
    'until' in value &&
    number(value.until) &&
    'since' in value &&
    number(value.since) &&
    'providerID' in value &&
    typeof value.providerID === 'string' &&
    'model' in value &&
    typeof value.model === 'string'
  )
}
