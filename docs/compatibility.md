# Transport experiment status

The bounded experiment passed. The configurable bridge is deployed as a persistent systemd service; fresh DM and prefixed group requests passed on the deployed service.

| Check | Result |
|---|---|
| Target OS | Ubuntu 24.04.5 LTS, Linux x86-64 |
| Node | 24.21.0 |
| OpenClaw installed version | 2026.9.6 (eb377ac) |
| Existing Gateway | Active; authenticated; configured to bind LAN |
| Chat Completions endpoint | Separate authenticated Gateway on loopback port 18790; original Gateway unchanged |
| Production dependencies | Bridge-owned HTTP transport; playwright-core 1.63.0 for interactive credential capture; production audit reports zero vulnerabilities |
| Browser | Playwright 1.58.2, Chromium 145.0.7632.6 installed |
| Browser access | Dedicated account, loopback VNC/web access; private tunnel required |
| Root EBS volume | Encryption is false; operator explicitly waived encryption requirement |
| Teams login/read/send | Account verified through server profiles; designated DM and group reads passed; direct API sends confirmed in both |
| OpenClaw HTTP/session isolation | Three synthetic HTTP turns passed: same-session recall, separate-session non-recall; tools and skills disabled |
| Live Teams → OpenClaw → Teams | Passed: one new allowlisted DM and one prefixed group request received confirmed replies in their original chats |
| Automated verification | 30 tests passed locally and on Ubuntu / Node 24.21.0, including real SQLite, local HTTP and killed-process recovery |
| Persistent services | Bridge and isolated Gateway enabled; two fresh requests delivered; authenticated bridge reports ready |
| Restart/renewal | Both dedicated services restarted; two confirmed turns remained sent without additional queue entries; overnight, host reboot and automatic renewal not established |

Account names, SSH aliases, chat names, IDs and credentials remain outside public configuration. The original Gateway and agent configuration remain unchanged. A separate Gateway uses its own state and a single tool-free test agent. Operator explicitly waived encryption on 2026-10-02. Continue with the dedicated account and protected-file permissions; these do not encrypt credentials.

Installed-build correction: this OpenClaw build uses keyed `agents.entries`, and retires implicit defaults for multiple agents. Candidate `agents.list` validation failed without changing active config. The probe therefore uses a separate single-agent Gateway rather than changing existing routing.

The first browser-seeded DM attempt did not arrive and was not retried automatically. A subsequent direct API test in the newly established, member-verified DM returned a confirmed message identifier. The initial candidate dependency was removed after its dependency audit found unpatched vulnerabilities. Production uses a smaller browser capture helper and its own bounded HTTP transport. Prefix-only group triggering is explicit; real mention metadata is unverified. No overnight, token-renewal or host-reboot claim is made.

## Current deployment: existing agent (2026-10-03)

The operator clarified that Teams must expose the existing OpenClaw agent and its current capabilities. The bridge now targets `main` on the original Gateway at loopback port 18789. Its Chat Completions endpoint was enabled after installed-version configuration validation; existing agent, model, tool, skill and workspace settings were retained. The separate test Gateway was stopped and disabled. The operator-authorized main agent capability boundary supersedes the isolated test-agent arrangement above.

The bridge was stopped before migration. An idle SQLite snapshot preserved chat cursors, deduplication and confirmed turns; a new state directory and session namespace bind future turns to the main agent. Three existing confirmed turns remained sent with no replay. Protected Teams credentials were carried forward, and the service’s writable-state path was updated. Both original configuration and bridge configuration were backed up privately. The migrated bridge reports authenticated and ready. Fresh DM and prefixed group requests both received confirmed replies containing their expected main-agent test markers. Five total turns are sent, including the three preserved turns; no unresolved jobs remain. Only the original OpenClaw Gateway is running.

## Reply formatting (2026-10-03)

Production sends now use `RichText/Html` with escaped content and a small Markdown renderer. A one-time preview delivered to the authorized test DM was read back from Teams as rich text with paragraphs, bold and bullet markup intact. All 33 tests pass locally and on the EC2 Node 24 host, including the actual service HTTP payload assertion and HTML-escaping cases. The bridge remains active. Existing messages are not edited.

### Report layout follow-up

Teams requests now include supplemental presentation guidance: brief status, concise separate check/metric bullets, blank sections and distinct caveats, preserving values and uncertainty. Explicit breaks between HTML blocks address Teams paragraph-margin suppression. Installed endpoint source confirms system messages are passed as supplemental agent instructions. A real main-agent formatting-only test produced seven bullets and preserved every checked value and timestamp from the supplied report; its preview was confirmed delivered as rich text in the authorized DM. All 34 tests pass locally and on EC2. This verifies the sampled report, not a guarantee of identical model formatting on every turn.

### Numbered metrics

Teams presentation guidance now explicitly requests a timestamped metrics section with one bold label/value per numbered item for three or more values. All 34 tests pass locally and on EC2. An initial formatting-only response failed the numbered-layout assertion and was held back; a subsequent explicit reformatting request produced all five expected metric rows with the supplied values and timestamp preserved. Its preview was confirmed delivered and read back with ordered-list markup. Model compliance can vary; these results validate the sampled response.

## Per-user access across chats

Optional `everywhereSenders` grants specific MRI identities access in DMs and automatically discovered group chats containing the bot and an authorized sender. `groupPrefix` sets the default trigger; configured group prefixes override it. Channels remain excluded. Permissions are rechecked before invocation and delivery; separate explicit grants continue to apply after global revocation. All 36 tests pass locally and on EC2, including an actual runner process discovering an unlisted group and DM while rejecting history, other senders and untriggered traffic. The deployed bridge reports authenticated and ready with the operator-requested permission saved privately. No message was sent to the newly allowed person as part of this configuration change.

## Read receipts and processing reactions (2026-10-03)

Optional `markRead` and `acknowledgementReaction` acknowledge newly accepted requests before agent invocation. The deployed configuration enables read receipts and the Teams `think` reaction (🤔). Fresh operator-sent DM and prefixed group requests both received replies. Independent Teams API readback confirmed the bot's thinking reaction on each input message and a consumption horizon at or beyond each message. No unresolved jobs remained.

Acknowledgement states are durable and separate from reply delivery: interrupted or ambiguous writes are not automatically repeated, known throttling can defer processing, and expired authentication preserves the queued request for re-login. Cosmetic failures do not discard an otherwise accepted request. The reaction indicates bridge acceptance for processing; the final reply confirms the agent responded. All 42 automated tests passed locally and on EC2, including real runner HTTP payloads, read-horizon protection, authentication and crash recovery. Both options default to disabled in public configuration.

## Typing presence (2026-10-03)

Optional `typingIndicator` sends transient `Control/Typing` events during agent generation, refreshes every four seconds, and sends `Control/ClearTyping` on success or failure. It defaults to false and is enabled on the deployment. Notifications use the existing bounded Teams transport and request budget; they do not create queued user turns, retry agent invocations, or discard replies when presence fails. Refreshes are sequential and stop before the clear notification.

The control-message form follows the [SkPy client implementation](https://github.com/Terrance/SkPy/blob/master/skpy/chat.py); compatibility was then checked against the deployed Teams account. Teams accepted a start and clear notification in the authorized test DM. All 45 tests passed locally and on EC2, including refresh/cleanup and failure isolation. Client-side visual display is awaiting operator confirmation; API acceptance alone does not prove the indicator is visible in every Teams client.

## Automatic saved-session renewal (2026-10-04)

A ten-minute systemd timer now checks the existing Teams credentials and verifies the account server-side. Renewal is due within thirty minutes of a JWT expiry, after six hours for opaque credentials, or when the identity check reports expired authentication. A short-lived headless Chromium session uses the operator's existing dedicated profile and observes ordinary Teams login requests. Only credentials verified for the configured account replace the protected file. The running bridge rechecks credential changes between turns and adopts them without restarting an active invocation.

A forced live renewal completed successfully in approximately fourteen seconds; the bridge logged `credentials-reloaded` and remained authenticated, with all 22 completed turns preserved and no unresolved jobs. The installed scheduled service then successfully reported `renewal-not-needed`, leaving Chromium closed. The timer is enabled for boot and its next check is scheduled. Runtime is capped at three minutes, memory at 900 MB, and the process group is killed on timeout. All 49 automated tests pass locally and on EC2, including actual runner credential rotation without duplicate invocation or delivery, account mismatch, expiry, and preservation on capture failure.

Microsoft can still require password/MFA or revoke the saved browser session. The renewal service then fails without replacing credentials; operator login remains necessary. This verifies renewal and scheduling on the current host, not an overnight or reboot observation.

## Inline images (2026-10-08)

Optional `media` adds inbound Teams inline images and outbound native image attachments through the existing main agent/Gateway. Authorized inbound object IDs are retained with their queued request, downloaded only from the fixed Teams AMS origin, bounded, signature-checked, and forwarded as image data parts. Group prefixes remain required. Image-only DMs receive a description prompt. PNG, JPEG, GIF and WebP are supported; arbitrary remote URLs and SharePoint file attachments are excluded. Defaults are four images, 5 MB per image, and 10 MB total per turn.

Outbound image references are restricted to explicit export roots. The existing agent receives supplemental guidance to export finished files there and emit `TEAMS_IMAGE:` references. Protected reply parts save the image bytes before upload; later file edits do not change a saved reply. Upload object IDs are saved before chat submission. Authentication expiry preserves saved output, and ambiguous delivery remains paused rather than repeated.

The dedicated Teams page's IC3 media token is captured from its MSAL browser storage, checked against the configured account, and kept only in protected credentials. Scheduled renewal now accounts for its independent expiry. A live saved-session renewal captured media credentials successfully and the browser closed. The existing OpenClaw identified all three colors in a synthetic test image and returned a valid file reference. A native image was sent to the authorized test DM; Teams API readback confirmed rich-text image markup and successful image download. Fresh operator-sent inbound image confirmation remains pending.

The deployment also resumed Baly - SRE after an `Event/Call` message had paused its old unsupported-type parser. Call, typing and unsupported attachment events now advance scanning without invoking the agent. The group subsequently caught up with no pause or unresolved jobs. All 57 tests passed locally and on EC2. Checks cover policy, media HTTP payloads, bounded reads, file restrictions, durable bytes, current-turn image return, auth preservation, account mismatch and uncertain sends.
