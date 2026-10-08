---
name: teams-send
description: Send a computed report, image, or cron-job result to Microsoft Teams through the local user-account bridge. Use when explicitly asked to deliver a result to Teams, or when a scheduled job's instructions specify Teams delivery.
---

# Send results to Teams

Read `config.local.json` in this skill directory to obtain the destination alias and socket path. The operator configures the default destination here; `--target` can override it with another bridge-approved alias. Do not infer a destination from unrelated chat history. The bridge owns Teams credentials; this skill needs none.

Compute the requested report with the existing appropriate skill first, then send its actual output:

```bash
python3 ~/.openclaw/skills/teams-send/scripts/send.py --id '<stable-event-or-job-run-id>' --text '<computed report>'
```

For an image, export its real bytes into a configured bridge media root, with group read permission, then add `--image /absolute/export/chart.png`. The text can also come from stdin for command-based scripts. Use subprocess argument arrays when embedding the sender in another skill; never build a shell command from report text.

`--id` must identify one result/run. Reuse that ID when retrying that same result, including after a timeout; use a new ID for a new scheduled occurrence. The bridge persists accepted text and image bytes, shares the existing send budget, and does not invoke an agent again. A successful CLI result means queued, not confirmed delivered. Delivery status is available in bridge status. If sending is ambiguous, the bridge pauses the chat for operator reconciliation; do not work around this with a new ID.

For an OpenClaw agent cron job, instruct it to compute the report and call this sender with its configured target. Set cron fallback delivery to `none` / `--no-deliver` to avoid an additional announcement. Command cron jobs can run a script that computes a result and calls this sender directly. Do not create or change schedules unless requested.

Targets may be DMs, group chats, or explicitly configured team/channel thread IDs. The bot user must have permission to post in that destination. Channel posting must be verified for the operator's tenant; current deployment live checks cover chats, not a team channel. Incoming team-channel monitoring is not enabled by this skill.
