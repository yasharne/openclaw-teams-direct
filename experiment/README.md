# Bounded transport experiment

These scripts prepare a dedicated Ubuntu 24.04 account and a visible browser for manual Teams sign-in. They do not implement message forwarding, auto-replies, credential renewal or a production service.

1. Review and run `prepare-host.sh` as root on the intended host.
2. Place `package.json` in `/var/lib/teams-bridge-probe/app` and install with `npm install --ignore-scripts`. This avoids optional credential-store lifecycle scripts. Build the root project first; review the resolved package and preserve the lockfile before release.
3. As the dedicated account, run `npx playwright install chromium` from that directory.
4. Verify the browser profile and all credential-bearing paths use directories mode 0700 and files mode 0600. The initial deployment operator explicitly waived disk encryption; file permissions do not provide encryption. Decide your own disk policy before deployment.
5. Run `start-browser.sh` as root. It creates temporary systemd units, not boot-enabled services. All login components automatically expire after 30 minutes, including Chromium child processes. Set `TEAMS_LOGIN_MAX_SECONDS` (60–7200) for a different limit. A failed startup stops components already created. Browser sandboxing is disabled for this isolated unprivileged probe; production hardening remains unresolved.
6. Forward local port 18880 to host loopback port 6080 using SSH, then visit `http://127.0.0.1:18880/vnc.html` and connect. VNC and the browser debug port must never be publicly exposed.
7. Sign in manually. Never paste passwords or token bundles into chat, terminal logs or repository files.

Immediately after credential capture, stop the experiment with `sudo systemctl stop teams-probe-browser teams-probe-web teams-probe-vnc teams-probe-display`. The browser profile remains credential-bearing after shutdown; stopping processes does not remove credentials.

Live messaging still requires a uniquely resolved authorized recipient and group. The initial candidate client was used for the first feasibility test and has been removed from production and this manifest after its dependency audit. The probes now reuse the root project's compiled browser capture; run the root build before using them. Historical tested versions and live results are recorded in compatibility.md. The persistent service implements its own bounded HTTP adapter.


The remaining probes are explicit, opt-in scripts:

- `transport-check.mjs` captures the signed-in session into `TEAMS_PROBE_STATE`, verifies identity access, and reads the first conversation page. It never prints credentials or message bodies.
- `inspect-chats.mjs` uses `TEAMS_PROBE_GROUP` to uniquely resolve the designated group and inspect its members. It saves raw responses locally; these files are confidential.
- `send-test.mjs` accepts `TEAMS_PROBE_ACCOUNT`, `TEAMS_PROBE_KIND` (`group` or `dm`), and the relevant `TEAMS_PROBE_GROUP` or `TEAMS_PROBE_RECIPIENT`. It verifies identity and DM membership, records an attempt before sending, and refuses an existing attempt marker. Reconcile interrupted sends manually.
- `configure-openclaw-probe.py` creates a separate single-agent Gateway configuration under the existing OpenClaw account's `~/.openclaw-teams-probe`. Validate private networking before use. It does not change the original Gateway. This is specific to the validated `agents.entries` build; inspect your installed schema first.
- `openclaw-check.py` makes three synthetic turns to test history separation. Its marker prevents automatic repetitions after interruption.
- `relay-check.mjs` accepts only the configured sender in a uniquely resolved DM and group, ignores older messages using the Teams service clock, and handles at most one turn in each chat. It stops after ten minutes. It saves an invocation/send marker before each external action and never automatically retries uncertainty. Group trigger mode for this experiment is prefix-only; mention support remains unverified.

The relay reads private `relay-config.local.json`:

```json
{
  "version": 1,
  "accountEmail": "bridge-user@example.com",
  "recipientEmail": "tester@example.com",
  "groupTopic": "Designated test group",
  "triggerPrefix": "!claw"
}
```

It also needs `openclaw-secret.local.json` with `url`, `agent`, and `token` for the separate loopback Gateway. Transfer the token locally into a file owned by the probe account with mode 0600; never copy it to chat or public configuration. Stop the separate Gateway with `systemctl --user stop openclaw-teams-probe`. These tools do not satisfy the production SQLite queue, fair scheduler, retention, renewal, restart or package-release requirements in the approved design.
