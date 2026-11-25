# Who owns a suspended turn?

**OpenCode owns execution. A provider owns knowledge of its quota. The plugin owns only a deadline.** This matters on restart: if both the plugin and OpenCode sent a new prompt, a single interruption could run the same task twice.

```text
primary HTTP response ── provider observation (optional; same session and route)
                                      │
OpenCode retry hook ── provider resolves deadline or returns unknown
                                      │
                          validate and persist deadline
                                      │
                           OpenCode retries its turn

managed service restart ── OpenCode recovers claimed turn
                                      │
                          context hook checks saved deadline
                                      │
                              original dispatch
```

### Adding a source

Implement `ProviderAdapter` in `src/runner.ts` and register the provider ID in `src/providers.js`. `resolve` returns an **absolute Unix timestamp in milliseconds**, not a delay or a percentage. It must distinguish a subscription refusal from authentication, balance and transport errors. `observe` is optional: use it when the request that failed identifies the account or the local proxy more reliably than the retry error alone. Never cache or persist the original HTTP request or credential. Providers don't send prompts, change models, or create timers.

For overlapping windows, first select the windows that actually block **this** model. Their maximum reset is the first time all of them could be clear. A reset time by itself doesn't establish exhaustion. Missing data for a blocking window is not evidence for an earlier retry.

“Unknown” is not a veto: leave the host's current retry decision intact. An elapsed window no longer blocks. A deadline more than 31 days away is outside these subscription contracts and must not be persisted; this also catches microseconds accidentally interpreted as milliseconds.

### Changing recovery

`policy.ts` contains the pure routing and deadline rules. `runner.ts` connects those rules to the host's retry, storage, prompt and context hooks. Persist before asking OpenCode to wait. Each checkpoint contains the deadline, agent, provider, model and variant under a session-scoped key. It contains no prompt text or authentication material. The plugin can delay an existing execution but has no code path to create one. Consequently an overdue checkpoint alone cannot wake a canceled or finished session.

Recovery inherits the host's limits: OpenCode bounds the number of attempts; a provider can change its quota after reporting a reset. The plugin doesn't roll back tool side effects or guarantee exactly-once tool execution after a process crash. Native recovery is a managed-service feature, not a replacement for a daemon.

Checkpoint reads and writes for one session are ordered. Provider lookups and sleeps happen **outside** that critical section so manual input can cancel an outstanding lookup or release a recovered wait. A message typed while OpenCode itself is sleeping on a delay this process set keeps the wait shown, because OpenCode cannot be told to stop that sleep; the held turn still runs at the reset. A wake-up rereads storage rather than deleting the checkpoint it originally saw: another refusal may have replaced it.

### Proof required for changes

1. Test the provider boundary with the actual wire shape: a future reset, two exhausted windows, an unrelated refusal, missing/old data, and an account or model mismatch.
2. Exercise the package via the real OpenCode entry point with an isolated home and local upstream. Assert request timestamps, original model and original session history, not just “eventually DONE”.
3. For changes to ownership, run the restart, cancel and manual continuation scenarios. As a negative control, use `QUOTA_RESUME_PLUGIN=test/fixtures/noop-plugin bun scripts/e2e.js go`: the same quota refusal must **not** resume successfully.

Upstream contracts: [OpenCode retry](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/runner/retry.ts), [managed restart](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/session/execution/restart.ts), [Go usage](https://github.com/anomalyco/opencode/blob/v2.3.2/packages/core/src/usage-limits.ts), [Meridian quota route](https://github.com/rynfar/meridian/blob/8f5e705a72a928be910e4c234c6b75fc289c068d/src/__tests__/proxy-usage-quota-route.test.ts), [Orca provider implementations](https://github.com/stablyai/orca/tree/main/src/main/rate-limits/providers).
