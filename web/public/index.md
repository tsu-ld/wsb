# wsb

> wsb is a free, open-source OpenCode plugin. It waits for your subscription's usage limit to reset, then OpenCode retries the same turn.

## Install

Needs OpenCode 2.3 or newer:

```sh
opencode plugin add github:tsu-ld/wsb
```

## What happens at the limit

1. Your provider refuses the request. wsb reads when the limit resets and tells OpenCode to retry then.
2. wsb makes no model calls while it waits, so waiting uses no quota. Esc cancels it.
3. At the reset OpenCode retries the turn you already sent, in the same session and with the same model. wsb never writes a prompt.

## Limits

- Works with Claude subscriptions (through opencode-with-claude or OpenCode's claude-agent provider), ChatGPT/Codex signed in with OAuth, and OpenCode Go. Pay-per-token API keys are not supported.
- wsb runs inside OpenCode, so it cannot wake it. If OpenCode is closed at the reset, nothing resumes; if the machine is asleep, the turn resumes late.
- Whenever wsb cannot read a reset time, it leaves OpenCode's normal retry alone.
- It does not bypass the limit. Your provider's terms still apply.

## Links

- [Full agent guide](/llms.txt): installation, supported subscriptions, behavior, and FAQ.
- [ARD manifest](/.well-known/ard.json): machine-readable capabilities and representative queries for agent discovery.
- [Source code](https://github.com/tsu-ld/wsb): MIT-licensed repository.

Sources: wsb README.md; ARCHITECTURE.md; web/public/index.html.
