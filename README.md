# OpenCode Quota Resume

When a subscription cuts off an OpenCode turn, wait for the reported reset and retry **that turn**. No second agent, provider switch, cron job or “continue” prompt. Orca is not required.

## Install

Tested with **OpenCode 2.3.2**. Clone this repository and add the **absolute path to the clone** to `plugins` in `opencode.jsonc`. No build, account sign-in or npm installation is needed for the plugin itself.

```sh
git clone https://github.com/tsu-ld/opencode-quota-resume.git
cd opencode-quota-resume && pwd
```

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-quota-resume"],
}
```

Keep any existing plugin entries. To uninstall, remove just this entry.

## Where the reset comes from

- **Claude Max via `opencode-with-claude` / Meridian:** reads the quota of the local proxy that returned the 429. Requires a fresh reading and an unambiguous Claude seat. Ordinary Anthropic API keys aren't supported. Tested against the Meridian 1.89.0 response contract, not a live subscription.
- **ChatGPT / Codex:** uses the reset in the subscription error, or reads usage from the ChatGPT account associated with OpenCode's active OAuth connection. The usage endpoint is first-party but undocumented. Metered OpenAI API keys are not eligible.
- **OpenCode Go:** checks the rolling, weekly and monthly windows on OpenCode's usage endpoint with the credential from the refused request. A Go-specific refusal can also supply its own retry delay. The plugin doesn't interpret a generic 429 as a Go subscription reset.

The plugin doesn't poll an inference endpoint or redeem reset credits. A manual prompt takes precedence. Interrupting the turn leaves it stopped. On a managed OpenCode service restart, OpenCode recovers its own unfinished turn; the plugin holds it to the saved deadline. It cannot revive a session that was already idle before installation or run while your machine is shut down.

## Verify or contribute

With Bun 1.4.5 and OpenCode 2.3.2 on `PATH`:

```sh
bun install --frozen-lockfile
bun check && bun test
bun scripts/e2e.js
```

The end-to-end suite starts real OpenCode services in temporary homes with local model servers and dummy credentials. It exercises all three providers, kills a service mid-wait, and checks the original session's history. No paid account is needed. See [Architecture](ARCHITECTURE.md) to add a provider or change recovery behavior.
