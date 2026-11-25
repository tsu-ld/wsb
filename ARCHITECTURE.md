# Architecture

wsb waits out subscription quota refusals. **OpenCode owns execution; a vendor owns knowledge of its quota; the plugin owns a deadline.** Only OpenCode retries its own failed turn after a plugin-set delay. Other hosts need their own lifecycle.

## Hosts

| Host        | What the host gives a plugin                                                                                                       | What this tree can reuse                                                                             |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| OpenCode    | A retry decision with a delay; the host retries its own turn                                                                       | Everything                                                                                           |
| Codex CLI   | A usage-limited turn ends without `Stop`; the app-server reports per-bucket usage                                                  | `deadline.ts`, `format.ts`; its own reader and a process that outlives the CLI                       |
| Claude Code | `StopFailure` has no decision control; interactive sessions already continue natively, unless disabled, and give up after 24 hours | `deadline.ts`, `format.ts`                                                                           |
| Amp         | `agent.end` has `status: 'error'` and may return `continue` with a new user message; no error body or reset time                   | `deadline.ts`, `format.ts`; a text reader at most                                                    |
| pi          | `after_provider_response` sees status and response headers; continuing after an error is undocumented                              | `deadline.ts`, `format.ts`; readers need response headers, while today's readers use request headers |

The OpenCode lifecycle is not a shared session core. Elsewhere the adapter must send the next message and own its timer, cancellation check and crash behavior.

## Layers and contracts

```text
src/
  deadline.ts        Reading, latestReset, plausible; no imports
  format.ts          countdown, clock, rise; no imports
  wire.ts            record, text, int, epochMs; no imports
  vendors/           meridian, chatgpt, go, claude-message
  opencode/          plugin, hold, locks, rpc, tui
    sources/         meridian, claude-agent, chatgpt, go, index
```

Dependency rule: `opencode -> vendors -> deadline/wire`, never the reverse. Vendors know their vendor's URLs and headers, but no hook event, session ID, credential shape or host error type.

```ts
type Reading =
  | { kind: 'until'; until: number }
  | { kind: 'unknown'; reason: string }
  | { kind: 'other'; reason: string }

latestReset(resets, now)
plausible(until, now)
```

`until` is absolute epoch milliseconds. `plausible` accepts only a safe integer later than `now` and at most 31 days away. `latestReset` voids the whole list on a non-number, unsafe or non-positive entry, skips elapsed entries and takes the maximum of the rest. `unknown` is a quota refusal with no trustworthy time: leave the host's decision alone. `other` is auth, balance, transport, wrong account or another non-waitable failure.

Vendor functions take explicit arguments, including `fetch` and `now`:

- `meridian.read({ origin, key, modelID, status, body, fetch, now })`
- `chatgpt.inferenceRequest(url)`, `parseRefusal(body, now)`, `readUsage({ token, account, fetch, now })`
- `go.inferenceRequest(url)`, `REFUSAL_STATUSES`, `parseRefusal(body)`, `windowDelay(delayMs, window, now)`, `readUsage({ authorization, org, fetch, now })`
- `claudeMessage.read(message, now)`

A source adapts one host provider ID to those arguments. Its two stages exist because OpenCode has two stages:

```ts
interface Source {
  atResponse?(event: SessionHttpResponse, now: number): Promise<Reading>
  atError(
    event: SessionRetry,
    earlier: Reading | undefined,
    now: number,
  ): Promise<Reading> | Reading
}
```

`atResponse` reads request headers and a clone of the response body. `atError` has no URL or headers. `earlier` is the response-stage reading for the same agent, provider, model and variant. The lifecycle ignores non-primary responses, replaces the observation on a primary response, clears it on a prompt or interrupt, and consumes it once on retry. A source uses it only when it is a plausible `until`; otherwise it returns its own reading. The ChatGPT source alone decodes OpenCode's OAuth credential shape and obtains credentials only inside `atError`. Missing error fields are empty; a thrown source error becomes `other: threw <name>`.

## Lifecycle rules

1. **Persist before waiting.** After the lookup and again after `storage.set` resolves, recheck cancellation and unload. Only then set the decision, computing its delay from the clock at that moment.
2. **Interrupts discard lookups.** A non-shutdown interrupt discards any in-flight result, removes the hold and wakes sleepers. A shutdown interrupt does none of these. Lookups are not aborted; they end on their own timeout.
3. **Context is a loop.** Take the session's wake signal, read and decide inside the queue, sleep outside it until the deadline or wake, then decide again. Return on pass or unload. Every sleep is unreferenced and at most `MAX_SLEEP_MS` (2,147,483,647), so longer waits are sliced.
4. **Dispatch is pure.** `dispatchDecision(stored, route, now)`: no hold passes; a plausible same-route hold sleeps; a plausible other-route hold passes and stays; anything else is removed and passes. A missing `since` and a `variant` are valid.
5. **Publication wakes sleepers.** A sleeper on an older deadline rereads storage and follows the new one, earlier or later.
6. **Unload never removes a hold.** It discards lookup results and ends sleeps.
7. **The TUI observes every visible change.** Notify on hold publication, release, removal of an expired or malformed hold, and setting or clearing a reason.
8. **A prompt distinguishes host-owned waits.** It discards lookups and releases the hold when the plugin is sleeping that session in `context`, or when this process has no record of a host-owned wait. It keeps the hold while OpenCode sleeps on a delay this process set and no `context` sleeper exists: OpenCode cannot cancel that sleep. The in-memory record is set on publication and cleared when `context` next runs, on interrupt and on unload.
9. **Reasons are in memory only.** Keep the latest `unknown` reading that ended a refusal without a hold as `{ at, reason }`, written only after rule 1's cancellation recheck. Clear it on release, hold publication and the next primary response below status 400. Keep only the 200 most recently written sessions. Never show `other`.

The per-session serialized queue orders storage reads and writes. One cancellation epoch replaces pending abort-controller sets; one wake promise replaces change sets. Holds live at `wait/<sessionID>` with `until`, optional `since`, `agent` and `model` (`providerID`, `id`, optional `variant`). They contain no prompt or credential. `hold.ts` is the single decoder and RPC projection, filling a missing `since`.

## Adding a vendor

1. Add a host-free parser, request recognizer and thin fetcher under `src/vendors/`. Import only `deadline.ts` and `wire.ts`; take explicit arguments and return a `Reading`.
2. Preserve the vetoes: distinguish subscription limits from auth, balance, transport and account/model mismatches. Missing blocking-window data is `unknown`, not an earlier deadline. Never infer exhaustion from a percentage or reset time alone.
3. Add wire-shape tests in `test/vendors/` using plain arguments and a supplied `fetch`.
4. Add an OpenCode adapter in `src/opencode/sources/`, map its host evidence into the two stages, and register the provider ID in `sources/index.ts`. Keep credentials and session headers in this layer.
5. Run `bun run check && bun test && bun scripts/e2e.js`.

## Adding a host

Put host events, credentials and execution in a separate adapter; reuse vendors only where their wire contract matches. A host that does not retry its own turn needs a lifecycle that sends a new message, rather than importing `opencode/plugin.ts`.

**Codex CLI is first.** A usage-limited turn ends without `Stop`, so an adapter needs a process that outlives the CLI. Give it its own reader for the app-server's `account/rateLimits/read` response and `rateLimitsByLimitId` buckets; the ChatGPT web-usage vendor is a different wire contract. Bucket `resetsAt` values are nullable. The schema says a null `ordinaryUsageAllowed` means unavailable and clients **must not infer recovery from percentages or reset times**; require backend permission before dispatching.

Persist the intended thread, model and deadline before waiting. Recheck a durable cancellation record after persistence and immediately before sending the turn. A process crash still forces a choice: at-most-once dispatch can miss a resume; at-least-once dispatch can duplicate a turn and its tool side effects. Choose explicitly, persist enough dispatch state to enforce that choice, and test the crash boundary. The host adapter also owns its timer, wakeups, unload and user-visible state.

## Proof required for changes

1. Run `bun run check`: formatting, lint, types, unit tests and `bun scripts/build.js --check`. The committed `dist/tui.js` must equal the in-memory build of `src/opencode/tui.tsx`.
2. Test vendor wire data in `test/vendors/*.test.ts` and OpenCode gates in `test/opencode/*-source.test.ts`: future and overlapping resets, unrelated refusals, missing/stale data and account/model mismatches.
3. Exercise `src/opencode/plugin.ts` through the real package entry point with an isolated HOME and local upstream: `bun test && bun scripts/e2e.js`. Assert request timestamps, original model and original session history. Rule tests live in `test/lifecycle.test.ts`; reason tests in `test/why.test.ts`.
4. For TUI changes, capture the real panel and footer in OpenCode. As a stale-build negative control, change a string literal in `src/opencode/tui.tsx` without rebuilding: `bun scripts/build.js --check` must exit 1, then revert and require exit 0.
5. As a plugin negative control, run `QUOTA_RESUME_PLUGIN=test/fixtures/noop-plugin bun scripts/e2e.js go 2>&1 | grep -c "Timed out: answer in original session and model"`; it must print 1. The `cancel` and `manual` scenarios also pass with the noop plugin, so they do not prove plugin participation by themselves.

Sources: `.ulw/architecture-redesign.plan.md`; `src/deadline.ts`, `src/wire.ts`, `src/format.ts`, all four `src/vendors/*.ts`, `src/opencode/{plugin,hold,rpc}.ts`, `src/opencode/tui.tsx` and all `src/opencode/sources/*.ts`; `test/lifecycle.test.ts`, `test/why.test.ts`, `scripts/e2e.js`; Bun 1.4.2 bundler docs via Context7; Solid 1.9.16 source; Codex `app-server-protocol/src/protocol/v2/account.rs` on main, opened 2026-11-25.
