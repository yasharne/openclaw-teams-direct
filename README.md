# OpenClaw Teams Direct

Connect Microsoft Teams text chats to a private OpenClaw Gateway using an existing Teams user account. Supports allowlisted direct messages and selected group chats triggered by a configurable prefix. No Entra app registration, Azure Bot or Teams app installation is used.

This uses an unofficial Teams client transport. It is not a Microsoft-supported bot integration. Interactive sign-in and your tenant's MFA or Conditional Access still apply; a username and password do not guarantee unattended access. Verify organizational permission to use the account this way.

The first live experiment passed DM and group round trips with OpenClaw 2026.9.6. The deployed persistent service also passed fresh DM and group delivery and a service restart; see [compatibility](docs/compatibility.md). Automatic renewal and overnight reliability are not established. Mention triggers, channels, files, voice, Docker and npm publication are not included in this release.

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
- `groups`: exact chat IDs, allowed sender MRIs and a required prefix; default examples use `!claw`.
- `namespace`: a stable, unique deployment name for OpenClaw sessions.
- `openclaw`: a loopback Chat Completions URL, an explicit agent ID and a protected local secret file containing `{"token":"YOUR_GATEWAY_TOKEN"}`. `OPENCLAW_TEAMS_GATEWAY_TOKEN` can override that secret.

Unknown fields and invalid values fail validation. Use `--config /absolute/config.local.json` or `OPENCLAW_TEAMS_CONFIG`. Account, state directory, deployment namespace or OpenClaw connection changes require a new state namespace; do not reuse pending jobs against a different destination.

```sh
node dist/src/cli.js validate --config /absolute/config.local.json
```

Defaults: polling 5 seconds; DM discovery 60 seconds; 60 Teams requests/minute; at most two requests in flight; two pages per chat turn; 10,000 scanned messages per chat; 1,000 queued jobs; Teams deadline 20 seconds; OpenClaw deadline 90 seconds; reply parts at most 3,000 Unicode characters. These are configurable operational limits, not Microsoft quotas. Changes to the request budget, concurrency or Teams deadline require a service restart. Access lists and group prefixes are reloaded while running. Budget saturation increases latency. Discovery, identity, member checks, paging and sends all count against the budget.

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

Authentication expiry stops with status `needs-login` and exit code 42 while retaining queued work. Sign in again, capture the session and restart the service. It never loops through password or MFA prompts in the background.

## Run and recover

[systemd template](service/openclaw-teams-direct.service) includes restricted file access and stops automatic restart on authentication expiry. Adjust account and paths to your host. Install code and dependencies in a separate directory, then enable the unit. Keep the OpenClaw Gateway service independently managed. Test sign-in and queue recovery after reboot before relying on unattended operation.

```sh
node dist/src/cli.js status --config /absolute/config.local.json
```

Replies are sent as Teams rich text. Paragraphs and line breaks are preserved; Markdown bold, inline/fenced code, headings, lists and HTTP(S) links are rendered. Raw model-generated HTML is escaped. This is a small supported Markdown subset.

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

## Development and distribution

```sh
npm run check
npm pack --dry-run
```

Tests use synthetic identities, temporary real SQLite, real local HTTP endpoints and process crash injection. Live tenant tests are explicit and separate. Package contents are allowlisted. The package remains private to prevent accidental npm publication; no release workflow uploads tenant credentials. Source is published under the MIT license on GitHub.

See [engineering design](docs/design.md), [review](docs/engineering-review.md), [test plan](docs/engineering-test-plan.md), [security](SECURITY.md) and [contributing](CONTRIBUTING.md).
