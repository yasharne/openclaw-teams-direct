---
name: teams-call
description: Ring an explicitly configured person in Teams for an authorized alert, using the existing bot user session. Use when asked to call someone, or when a scheduled job explicitly requests a ring-only Teams alert.
---

# Teams ring-only alerts

Read `config.local.json` in this skill directory for the default target alias. Call only when the user or job instructions authorize a call. To call another recipient, that alias must first be approved in the private caller configuration. Do not infer permission from access to messaging aliases.

```bash
python3 ~/.openclaw/skills/teams-call/scripts/call.py --id '<stable-alert-event-id>'
```

`--target` overrides the default alias. A new alert event uses a new ID. Reuse the same ID on retries: once a call attempt is recorded, it is never dialed again automatically, including after uncertain completion. Do not bypass a prior attempt using a new ID.

The caller verifies the signed-in account and exact chat heading after navigating with the configured DM ID. It mutes microphone tracks, waits for the configured ring window, attempts to leave, and closes Chromium in all exit paths. This is a ringing alert, without spoken content. Ring duration is best effort because the recipient can answer or reject sooner, and server-side termination can lag browser closure. Caller output records an attempt, not proof of recipient notification.

Use `--check` for a non-dialing identity/navigation check. The bounded launcher requires systemd and the operator's existing sudo permission, and limits the browser to two minutes and 900 MB. Do not leave a persistent browser or automatically retry profile contention with login renewal. No scheduled calls are created by this skill.

## Reporting the result

Read the sender's structured results and exit code. A nonzero `serviceExitCode`, an `error`, or `failed-before-call` means the call failed or is unconfirmed. `call-click-unconfirmed` is an uncertain UI attempt, never a completed call. A duplicate means no new call was placed. `browser-closed` only means browser cleanup; it does not mean the call completed. `call-button-clicked` proves only that Teams accepted the UI action. Never report "placed", "rang", or "completed" from those results or a successful process exit. Without recipient confirmation, say "Call attempted; ringing is not confirmed." Do not claim the user answered or received a notification.
