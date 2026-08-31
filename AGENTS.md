# Agent guidance for pi-better-grok

## Project layout

- `index.ts` registers the pi extension commands, events, settings UI, footer/status rendering, usage polling, and fast-mode lifecycle.
- `src/` contains focused helpers for config, formatting, xAI OAuth credential resolution, and Grok subscription usage.
- `tests/` contains Vitest coverage. Prefer adding targeted tests near the changed behavior.
- `.pi/` is local runtime/config/generated output and is ignored by git.

## Verification

Run the narrowest useful test first, then the full gate before committing:

```bash
bun install --frozen-lockfile
bun run test -- tests/<file>.test.ts
bun run check
```

`bun run check` runs typecheck, lint, format check, and all tests. Do not skip it for code changes.

## Coding conventions

- Use TypeScript ESM imports with `.ts` extensions, matching the existing files.
- Keep runtime behavior in `index.ts` small where possible; put pure helpers in `src/` and test them directly.
- Preserve unknown JSON config fields when writing settings.
- Do not commit `node_modules/`, generated `.pi/` images/config, auth files, or other local machine state.

## Security reminders

- Never paste, log, or commit token/auth file contents. The auth store is normally `~/.pi/agent/auth.json` (keys `xai`, `xai-oauth`, `xai-auth`) or `~/.grok/auth.json`.
- Mask account/user IDs in diagnostics and examples.
- The `cli-chat-proxy.grok.com` surface is an unofficial, reverse-engineered contract — pin request shapes and treat schema drift as expected.
- Do not suppress high-severity audit findings without an actual remediation.
