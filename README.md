# wsb

[![wsb waits for your usage limit to reset, then OpenCode retries the turn](web/public/assets/social.png)](https://wsb.tsu.ar/)

OpenCode plugin. When your subscription hits its usage limit, it waits for the reset and retries the same turn.

```sh
opencode plugin add github:tsu-ld/wsb
```

Works with Claude subscriptions (through `opencode-with-claude` or OpenCode's `claude-agent` provider), ChatGPT/Codex and OpenCode Go.

![An OpenCode session hits its 5-hour limit: wsb reads the reset time from the provider's message, no model call is made for 24 minutes, and at 03:17 OpenCode retries the same turn](web/public/assets/night.gif)

## Develop

```sh
bun install && bun run check && bun scripts/e2e.js
```

`src/opencode/tui.tsx` compiles to `dist/tui.js`, which is committed because git installs load it. `bun run check` fails when the build is stale.
