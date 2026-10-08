# OpenClaw Teams Direct

Connect Microsoft Teams text chats to a private OpenClaw Gateway using an existing Teams user account. Supports allowlisted direct messages and selected group chats triggered by a configurable prefix. No Entra app registration, Azure Bot or Teams app installation is used.

This uses an unofficial Teams client transport. It is not a Microsoft-supported bot integration. Interactive sign-in and your tenant's MFA or Conditional Access still apply; a username and password do not guarantee unattended access. Verify organizational permission to use the account this way.

The first live experiment passed DM and group round trips with OpenClaw 2026.9.6. The deployed persistent service also passed fresh DM and group delivery and a service restart; see [compatibility](docs/compatibility.md). Optional saved-session renewal is available; unattended operation remains dependent on Microsoft sign-in policy. Mention triggers, incoming channel monitoring, general file attachments, voice, Docker and npm publication are not included in this release.

## Install

Use Node 24.12 or newer on Linux. The EC2 setup tested Ubuntu 24.04 and Node 24.21.0. On macOS use canonical paths rather than `/var` symlink aliases.

```sh
npm ci --ignore-scripts
npm run check
npm run build
node dist/src/cli.js help
```

Lifecycle scripts stay disabled. Production uses `playwright-core` only to connect to an existing browser, a bridge-owned Teams HTTP adapter, and explicit protected-file credential storage. The initial candidate client is not a production dependency. Runtime commands never print token bundles or message bodies.

## Configure

Create a dedicated OS account and a private directory for its configuration and state. Copy [config.example.json](examples/config.example.json) into that directory, owned by that account with mode 0600; directories must be mode 0700. Keep credentials, browser profiles, SQLite files and actual account/chat IDs outside the repository. Set your own disk encryption policy. File permissions do not encrypt data and do not exclude host administrators.

Replace every placeholder:

- `accountId`: the account's verified Teams MRI, such as `8:orgid:<UUID>`. Routing uses IDs rather than names.
- `dmSenders`: the allowed sender MRIs. Newly discovered DMs must have exactly the bridge user and an allowed sender.
- `everywhereSenders`: optional sender MRIs allowed in DMs and any discovered group chat containing both the bot and an authorized sender. Defaults to an empty list. Future matching group chats are discovered automatically; channels are not included.
- `groupPrefix`: default trigger for groups discovered through `everywhereSenders`, default `!claw`. An explicit group entry overrides this prefix.
- `typingIndicator`: optional boolean, default false. Refreshes Teams typing presence every four seconds while the agent generates a response, then clears it. Presence shares the request budget and is best effort; failures do not discard replies.
- `markRead`: enable read-horizon updates for accepted requests (default `false`).
- `acknowledgementReaction`: optional Teams reaction key, default empty/disabled. Set `"think"` for 🤔 (`thinkingface` in the Teams emoji catalog).
- `groups`: exact chat IDs, allowed sender MRIs and a required prefix; default examples use `!claw`.
- `namespace`: a stable, unique deployment name for OpenClaw sessions.
- `openclaw`: a loopback Chat Completions URL, an explicit agent ID and a protected local secret file containing `{"token":"YOUR_GATEWAY_TOKEN"}`. `OPENCLAW_TEAMS_GATEWAY_TOKEN` can override that secret.

Unknown fields and invalid values fail validation. Use `--config /absolute/config.local.json` or `OPENCLAW_TEAMS_CONFIG`. Account, state directory, deployment namespace or OpenClaw connection changes require a new state namespace; do not reuse pending jobs against a different destination.

```sh
node dist/src/cli.js validate --config /absolute/config.local.json
```

Defaults: polling 5 seconds; DM discovery 60 seconds; 60 Teams requests/minute; at most two requests in flight; two pages per chat turn; 10,000 scanned messages per chat; 1,000 queued jobs; Teams deadline 20 seconds; OpenClaw deadline 90 seconds; reply parts at most 3,000 Unicode characters. These are configurable operational limits, not Microsoft quotas. Changes to the request budget, concurrency or Teams deadline require a service restart. Access lists and group prefixes are reloaded while running. Removing a sender from `everywhereSenders` revokes that global permission; any separate DM/group grant still applies. Budget saturation increases latency. Discovery, identity, member checks, paging and sends all count against the budget.

## Prepare OpenClaw

Enable `gateway.http.endpoints.chatCompletions.enabled` on an authenticated private Gateway. The bridge connects through loopback. Its shared token carries operator authority: chat-session separation does not restrict tools, workspace or memory access.

Choose the agent whose capabilities you want Teams users to receive. To expose your existing OpenClaw setup, enable this endpoint on its Gateway, set `openclaw.agent` to its existing agent ID (for example `main`), and use its Gateway token. Teams then uses that agent’s configured skills, tools and workspace without duplicating them. Per-chat sessions separate conversation history; they do not isolate shared files, skills, tools or global memory. Everyone on the sender allowlist receives the selected agent’s capabilities.

For restricted deployments, select a dedicated agent or separate Gateway with suitable tools and workspace. The initial transport experiment used an isolated tool-free Gateway; that arrangement is optional.

The tested build uses keyed `agents.entries` for explicit agents. Validate against your installed version; see the isolated [probe setup](experiment/README.md). Every request names the configured agent. Stable `user` values are derived from namespace, account, chat and reset generation, so each group has shared context and each DM has independent context.

## Sign in

Start a dedicated visible Chromium browser with a private profile and debug port 9222. Access it over an SSH tunnel; keep browser debugging, VNC and web access on loopback. [Experiment scripts](experiment/README.md) provide the validated EC2 manual sign-in path. Browser state is credential-bearing, including cookies and local storage. Never reuse your personal browser profile.

Sign in manually as the bridge account and complete MFA. Then run as the dedicated service user:

```sh
node dist/src/cli.js identity --config /absolute/config.local.json --port 9222
# Review the signed-in account, then put its accountId in your config.
node dist/src/cli.js login --config /absolute/config.local.json --port 9222
node dist/src/cli.js chats --config /absolute/config.local.json
node dist/src/cli.js members CHAT_ID --config /absolute/config.local.json
node dist/src/cli.js run --config /absolute/config.local.json
```

`identity` prints only the server-verified account ID and does not save credentials. Review the account signed into the browser, then configure that ID before login capture. Capture verifies the authenticated account server-side before replacing stored tokens. The CLI never prints credentials. `chats` and `members` intentionally print discovery metadata for configuration; do not commit that output.

On initial activation of a chat, messages older than its persisted service-clock cutoff are ignored. Send a fresh message after the service is ready. On restart the same cursor resumes. Edits, deleted messages, system events, self messages, unauthorized senders and unprefixed group traffic do not invoke OpenClaw. Unexpected malformed records pause the affected chat without advancing its cursor.

Authentication expiry stops with status `needs-login` and exit code 42 while retaining queued work. The optional renewal timer can recover this using a saved browser session. If Microsoft requires interactive sign-in, sign in again, capture the session and restart the service. It never fills password or MFA prompts in the background.

## Run and recover

[systemd template](service/openclaw-teams-direct.service) includes restricted file access and stops automatic restart on authentication expiry. Adjust account and paths to your host. Install code and dependencies in a separate directory, then enable the unit. Keep the OpenClaw Gateway service independently managed. Test sign-in and queue recovery after reboot before relying on unattended operation.

```sh
node dist/src/cli.js status --config /absolute/config.local.json
```

Replies are sent as Teams rich text. Paragraphs and line breaks are preserved; Markdown bold, inline/fenced code, headings, lists and HTTP(S) links are rendered. Raw model-generated HTML is escaped. This is a small supported Markdown subset. Explicit spacing separates sections even when Teams suppresses paragraph margins. Teams requests also carry presentation guidance: short status first, concise check bullets, separate observations, and preserved values/timestamps. Three or more metrics belong under a timestamped heading in a numbered list, with one bold label and value per line. This guidance supplements the existing agent configuration for Teams requests.

When enabled, the worker reacts and marks an accepted request read when it takes the turn for processing. 🤔 acknowledges bridge acceptance, not successful agent completion. The final reply confirms the agent responded. Read horizons are cumulative within a chat and never intentionally move backward. Reaction/read writes share the Teams request budget. Auth expiry preserves the queued turn; throttling defers it. Unsupported or uncertain acknowledgements are recorded without stopping an otherwise valid agent turn, and ambiguous acknowledgements are not automatically repeated. Status includes acknowledgement states.

Jobs progress through `queued → invoking → response_ready → sending → sent`. Replies and individual parts are saved before submission. Confirmed parts are not resent. Crashes/timeouts during invocation or sending mark the turn `uncertain` and pause its chat; other chats continue. Exactly-once external execution is not promised. A canceled HTTP request may already have executed tools or delivered a message.

Stop the bridge before operator mutations:

```sh
node dist/src/cli.js resolve JOB_ID complete --config /absolute/config.local.json
node dist/src/cli.js resolve JOB_ID cancel --config /absolute/config.local.json
node dist/src/cli.js resolve JOB_ID retry --accept-duplicate-risk --config /absolute/config.local.json
node dist/src/cli.js resume CHAT_ID --config /absolute/config.local.json
node dist/src/cli.js reset-session CHAT_ID --config /absolute/config.local.json
node dist/src/cli.js purge --config /absolute/config.local.json
```

`retry` explicitly accepts possible duplicate tool execution or messages. It reuses a saved reply when one exists. `resume` discards an incomplete scan while preserving its cursor; resolve failed/uncertain/expired jobs first. `reset-session` requires no pending turns and starts a new OpenClaw conversation generation. Use it before expanding group membership when previous context should not be shared. `purge` deletes saved payloads and pauses unfinished work for resolution.

Completed/canceled/failed payloads expire after 24 hours; queued and uncertain payloads expire after seven days and require resolution. Dedup records below the cursor expire after 30 days; cursor-boundary IDs remain to prevent equal-timestamp replay. Logs report categories and counts without message bodies or raw transport errors. SQLite deletion and checkpointing do not guarantee forensic erasure from storage or backups.

## Images

Enable `media` explicitly in your private configuration:

```json
"media": {
  "enabled": true,
  "maxImageBytes": 5242880,
  "maxImages": 4,
  "outboundRoots": ["/var/lib/openclaw-teams-media"]
}
```

Send an inline PNG, JPEG, GIF or WebP image to the bot in a DM, with an optional question. Image-only DMs ask the agent to describe the picture. In groups, put `!claw` and the question in the same image message; the prefix is still required. Existing sender permissions apply before any attachment is downloaded. Defaults allow four images, 5 MB each, with a 10 MB total limit per turn. Arbitrary external image URLs, SVGs and SharePoint file attachments are not fetched.

The bridge downloads Teams-hosted inline images from a fixed media-service host and passes their bytes to the existing OpenClaw agent as `image_url` data parts. This requires a Gateway/model that accepts image inputs. No new agent or Gateway is created. Unsupported call, typing and file events are ignored rather than pausing the chat.

For sending, create a dedicated export directory writable by the OpenClaw account and readable by the bridge account. Keep it outside home directories hidden by the service's `ProtectHome` setting. For example, make the directory owned by the OpenClaw user with the bridge group and mode `2750`; ensure generated image files grant that group read access. Configure that directory in `outboundRoots`. The bridge supplements agent presentation instructions to export finished images there. A final `TEAMS_IMAGE:/absolute/file/path.png` line becomes a native Teams image attachment; accompanying text stays a text reply. The agent can also return a currently received image with `TEAMS_IMAGE:input:1` (one-based input index), without accessing a local file. Only real files inside the configured roots are read. Symlinks, oversized files and unsupported signatures are rejected. Generated files in this export folder remain under your own cleanup policy. Existing skills that emit OpenClaw `MEDIA:` attachments need a Teams export path: the Chat Completions endpoint returns text only and strips native media payloads. The bridge instructs the agent to export those files and return `TEAMS_IMAGE:` lines. For reliable scripted skills, add an optional Teams output directory to the script, write files there with group read permission, and emit `TEAMS_IMAGE:` directly; keep the original `MEDIA:` behavior for native channels.

Image uploads require Teams' IC3 media access token. Login capture and automatic renewal also capture this token from the dedicated Teams page's MSAL browser storage, selecting only the media resource and verifying that its account matches the configured bot. Tokens remain in the protected credential file and are never printed. Media-token expiry triggers renewal, and saved image replies survive authentication expiry. Image bytes are saved in protected SQLite reply parts before sending and follow the existing payload retention policy. A successful upload object ID is persisted before message submission; ambiguous sends pause the chat and are not blindly repeated.

## Automatic saved-session renewal

Install and customize [renewal service](service/openclaw-teams-renew.service) and [timer](service/openclaw-teams-renew.timer) alongside the bridge. Set the user and installation paths, and create a private `renewal.env` containing absolute paths:

```text
TEAMS_CONFIG=/var/lib/openclaw-teams-direct/config.local.json
TEAMS_PROFILE=/var/lib/openclaw-teams-direct/browser-profile
TEAMS_BROWSER=/absolute/path/to/chrome
```

Use the existing dedicated Teams browser profile (directory mode 0700, owned by the service account). Adjust the unit's writable paths to include that profile and state directory. Enable with `systemctl enable --now openclaw-teams-renew.timer` and run `systemctl start openclaw-teams-renew.service` for an immediate check. Review results with `journalctl -u openclaw-teams-renew.service`. A successful check starts an expired/stopped bridge; it leaves a running bridge running.

Checks run every ten minutes. A valid token more than thirty minutes from expiry needs no browser; opaque tokens use a six-hour age threshold. The expiry claim is only a scheduling hint: account identity is always verified with Teams. Expired credentials also trigger renewal. Renewal opens a short-lived headless Chromium session, observes ordinary Teams authentication requests, verifies the configured account, and atomically replaces the protected credential file. The running bridge adopts it between requests, preserving conversations, cursors and pending replies. No password is stored for renewal.

The browser closes after success or failure; the systemd unit additionally kills its process group after three minutes and caps memory at 900 MB. Close the interactive login browser before automatic renewal, as Chromium profiles cannot be shared concurrently. For manual sign-in, stop the renewal timer first and start it again after closing the login browser. Password/MFA requirements or revoked sessions can still require manual login; failures appear in the renewal unit journal and leave existing credentials intact. To test capture immediately, run `node dist/src/cli.js renew --config /absolute/config.local.json --profile /absolute/profile --browser /absolute/chrome --force` as the service account with the browser closed.

## Development and distribution

```sh
npm run check
npm pack --dry-run
```

Tests use synthetic identities, temporary real SQLite, real local HTTP endpoints and process crash injection. Live tenant tests are explicit and separate. Package contents are allowlisted. The package remains private to prevent accidental npm publication; no release workflow uploads tenant credentials. Source is published under the MIT license on GitHub.

See [engineering design](docs/design.md), [review](docs/engineering-review.md), [test plan](docs/engineering-test-plan.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).

### Explicit command routing

If similarly named skills cause a slash command to run the wrong skill, configure an optional `commandInstructions` object. Keys match the entire accepted command after trimming and lowercasing; values are operator instructions appended to that current agent turn. For example, `{"/report status": "Read the report skill instructions and run its status command; use its documented Teams image export option."}`. This preserves the existing chat session and authorization rules. Keep deployment-specific skill names and paths in your protected local configuration.

### Scheduled and skill-originated delivery

Enable a local Unix-socket outbox and map destination aliases to exact Teams thread IDs:

```json
"outbound": {
  "enabled": true,
  "socketPath": "/var/lib/openclaw-teams-direct/outbound.sock",
  "targets": {
    "report": "19:REPLACE_WITH_CHAT_ID@thread.v2"
  }
}
```

The socket accepts local `POST /send` requests only. It exposes no network listener or Teams credentials. Its parent must be a real directory owned by the bridge account with no group/other write permission. The socket uses mode `0660`. When the OpenClaw user differs from the bridge user, prepare a shared socket directory owned by the bridge, with the OpenClaw user's group and mode `2750`, and add that directory to the service's `ReadWritePaths`. Authorized local group members can submit results to configured targets. Restart the service after enabling or changing the socket path; target changes take effect between turns.

```bash
openclaw-teams-send --socket /absolute/outbound.sock --target report \
  --id report-job:2026-10-08T12:00:00Z --text 'Scheduled report: all checks healthy'
```

Without `--text`, the command reads UTF-8 stdin. Repeat `--image /absolute/export.png` to attach files from the existing media export roots. The CLI must have a stable `--id`: reuse it when retrying the same event/run. An accepted result is durably queued, not confirmed delivered. Saved text and image parts use the existing formatter, shared Teams request budget, retention, authentication renewal and uncertain-send reconciliation. No agent invocation, read receipt or reaction is generated. Revoking a target cancels its unsent queued results. Deduplication lasts for the configured job/dedup retention period, not forever.

Install [the teams-send skill](skills/teams-send/SKILL.md) into the existing agent's skills directory. Copy its `config.example.json` to `config.local.json`, then choose the target alias and socket there. Its Python wrapper reads that configuration, so a report/cron skill can select its destination without embedding credentials or thread IDs. Ensure `openclaw-teams-send` is on that agent's PATH. Other scripted skills can call the same CLI with their own configured `target` value.

For OpenClaw agent cron jobs, ask the job to compute its report and call the skill sender, with `--no-deliver` to suppress duplicate fallback announcements. For command cron jobs, let the report script call the sender with its generated text and stable run ID. This does not redirect existing cron jobs automatically.

Explicit channel thread IDs (`@thread.tacv2` / `@thread.skype`) can be configured as outbound destinations. Posting depends on that user's channel membership and tenant permissions; live deployment validation currently covers DM/group transport, not team-channel posting. Incoming channel polling remains excluded. Verify a channel destination before scheduling production reports to it.
