# wsb

[![wsb: it’s so over at the usage limit, we’re so back at the reset](web/public/assets/banner.png)](https://wsb.tsu.ar/)

OpenCode plugin. When your subscription hits its usage limit, it waits for the reset and retries the same turn.

```sh
opencode plugin add git+https://github.com/tsu-ld/wsb.git#production
```

Works with Claude Max (via `opencode-with-claude`), ChatGPT/Codex and OpenCode Go.

## Develop

```sh
bun install && bun check && bun test && bun scripts/e2e.js
```
