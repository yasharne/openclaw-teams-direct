# TODOS

## Distribution

### Validate container deployment and authentication

**What:** Add a supported Docker deployment after the native EC2 bridge is validated.

**Why:** Let operators deploy a repeatable environment without manually installing the browser and runtime.

**Context:** The first release runs natively beside OpenClaw on EC2. Teams uses interactive browser sign-in with explicitly configured protected-file credentials; browser/session persistence and renewal are not yet proven. Containerization must preserve those behaviors rather than provide an image that only works until its first restart or expired session. Start from the native login/run/status flows and test private operator browser access, service-user ownership, protected persistent volumes, restart, host reboot and reauthentication. Verify amd64/arm64 support based on available browser artifacts. Do not expose browser-control ports publicly or bake credentials into image layers. Include an image build/publish pipeline and documentation only after the workflow is tested.

**Pros:** Repeatable installation and clearer deployment dependencies.
**Cons:** More browser/permission/platform maintenance and live authentication tests.
**Effort:** M (human: ~1–2 days / agent-assisted: ~3–6 hours)
**Priority:** P3
**Depends on:** Native EC2 transport validation, credential persistence/restart tests, working DM/group routing and documented reauthentication.

Approved as a follow-up during engineering review (8A), 2026-10-02.
