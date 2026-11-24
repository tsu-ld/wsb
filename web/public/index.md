# wsb

> Free, open-source OpenCode plugin that waits for a subscription quota reset and retries the same turn with the same model.

## Install

Requires OpenCode 2.3 or newer:

```sh
opencode plugin add github:tsu-ld/wsb
```

## Use wsb when

- Claude Max, ChatGPT/Codex, or OpenCode Go reaches a subscription usage limit during an OpenCode turn.
- You want OpenCode to resume automatically at the provider's reported reset time without sending a new session or switching models.

## Behavior

wsb reads the reset deadline, asks OpenCode's retry to wait, and preserves the deadline across restarts. A manual prompt or interrupt always wins. If the reset time is unknown, wsb leaves OpenCode's normal retry behavior unchanged.

wsb does not bypass usage limits or send requests before the reset. Metered OpenAI and Anthropic API keys are not supported.

## Links

- [Full agent guide](/llms.txt): installation, supported subscriptions, behavior, and FAQ.
- [ARD manifest](/.well-known/ard.json): machine-readable capabilities and representative queries for agent discovery.
- [Source code](https://github.com/tsu-ld/wsb): MIT-licensed repository with tests.

Sources: wsb README.md; ARCHITECTURE.md; OpenCode plugin documentation; llms.txt v2; ARD publishing guide.
