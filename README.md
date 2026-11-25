# wsb

[![wsb: your limit resets at 03:17 and OpenCode resumes at 03:17](web/public/assets/social.png)](https://wsb.tsu.ar/)

OpenCode plugin. When your subscription hits its usage limit, it waits for the reset and retries the same turn.

```sh
opencode plugin add github:tsu-ld/wsb
```

Works with Claude Max (via `opencode-with-claude`), OpenCode's native Claude Code provider (`claude-agent`), ChatGPT/Codex and OpenCode Go.

![A 5-hour limit in an OpenCode session: the limit hits at 02:52, wsb reads the reset time, no model call is made for 24 minutes, and at 03:17 OpenCode retries the same turn](web/public/assets/night.gif)

## Develop

```sh
bun install && bun scripts/build.js && bun check && bun test && bun scripts/e2e.js
```

`src/tui.tsx` compiles to `dist/tui.js`, which is committed because git installs load it. Run the build after changing the TUI part.
