# Third-party notices

This project's xAI/Grok subscription contract (endpoints, headers, and payload
shapes) was established by prior MIT-licensed work in the pi ecosystem. The
following projects were used as protocol references:

- **stnly/pi-grok** — OAuth 2.0 + PKCE / device-flow provider, cli-chat-proxy
  header parity (`x-grok-client-*`, `X-XAI-Token-Auth`, `x-authenticateresponse`).
  MIT License. Copyright (c) stnly.
- **puetsua/pi-grok-usage** — identity-first billing lookup
  (`GET /v1/user` → `GET /v1/billing?format=credits` with `x-userid`) and the
  `UsageSnapshot` contract this extension mirrors. MIT License.
- **apoapostolov/pi-grok-usage** — Grok CLI `~/.grok/auth.json` reuse and
  powerbar integration patterns. MIT License.
- **luxus/pi-xai** — Grok Build billing/usage surface (`BillingUsage`) and
  xAI imagine/video/web tooling references. MIT License.

All trademarks belong to their respective owners. These projects are not
affiliated with or endorsed by xAI.
