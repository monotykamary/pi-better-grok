# pi-better-grok

Better Grok/xAI for [pi](https://pi.dev) — mirrors the [pi-better-openai](https://github.com/monotykamary/pi-better-openai) UX for SuperGrok subscribers: fast mode, subscription usage in the footer, footer polish, and a settings picker.

## Install

```bash
pi install git:github.com/monotykamary/pi-better-grok
```

## Commands

| Command             | What it does                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `/grok-fast`        | Toggle fast mode (`reasoning_effort: "low"` injected into xAI provider payloads while enabled and the model is allow-listed) |
| `pi --grok-fast`    | Start with fast mode enabled                                                                                                 |
| `/grok-usage`       | Force-refresh and show SuperGrok subscription usage                                                                          |
| `/grok-usage debug` | Show diagnostics (auth source, last fetch, config path)                                                                      |
| `/grok-settings`    | Open the settings picker (footer, usage, fast mode)                                                                          |

## Usage widget

Piggybacks pi's native xAI login (`/login xai` → **Use a subscription**; tokens in `~/.pi/agent/auth.json` under `xai`). Falls back to `xai-oauth` / `xai-auth` auth-file entries and the official Grok CLI store at `~/.grok/auth.json`.

Data comes from the same revision-pinned Grok subscription surface used by the community `pi-grok-usage` extensions:

1. `GET https://cli-chat-proxy.grok.com/v1/user` (identity)
2. `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` (with the `x-userid` header)

Status widget line: `Usage: 66% left · ↺ 5d5h - Mon 5:34 PM` (weekly period + reset clock). Defaults to the widget area below the editor, like pi-better-openai; set `"footer": {"mode": "replace"}` for the full custom footer.

## Configuration

JSON config at `~/.pi/agent/extensions/pi-better-grok.json` (global) or `<project>/.pi/extensions/pi-better-grok.json` (project):

```json
{
  "persistState": true,
  "supportedModels": ["xai/grok-4.6", "xai/grok-4.5"],
  "fast": { "effort": "low" },
  "usage": {
    "enabled": true,
    "refreshIntervalMs": 60000,
    "showOnlyOnSubscriptionModels": true,
    "showResetTimes": true
  },
  "footer": { "mode": "status" }
}
```

Unknown fields are preserved on write.

## Roadmap

- `/imagine` via `api.x.ai/v1/images/generations` (API-key accounts)
- Live Search web tool (SuperGrok `x_search`)
- Footer pets (port from pi-better-openai)

## Acknowledgments

Protocol contracts and prior art: [stnly/pi-grok](https://github.com/stnly/pi-grok), [puetsua/pi-grok-usage](https://github.com/puetsua/pi-grok-usage), [apoapostolov/pi-grok-usage](https://github.com/apoapostolov/pi-grok-usage), [luxus/pi-xai](https://github.com/luxus/pi-xai). See `THIRD_PARTY_NOTICES.md`.

## Security

The `cli-chat-proxy.grok.com` surface is unofficial and reverse-engineered from the Grok CLI; treat schema drift as expected. This extension never logs or stores token contents and masks account IDs in diagnostics.
