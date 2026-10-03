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
