# Engineering Review: Teams account bridge

Date: 2026-10-02
Branch: main (no commits yet)
Target: [approved design](design.md)
Mode: FULL_REVIEW, staged implementation
Status: DONE_WITH_CONCERNS; engineering decisions settled, runtime feasibility unverified

## Step 0: Scope Challenge

The repository contains design documents only. There is no implementation, test framework, prior commit/review cycle or existing local service to preserve. The five-component proposal triggered the complexity check. User decision 1A retained the entire approved modular scope, but required a bounded transport experiment before building the persistent service. This is sequencing, not a feature cut. One process and ordinary modules are sufficient; no separate services, distributed queue, custom auth protocol or global framework is warranted.

## What already exists

| Existing flow | Reuse / boundary |
|---|---|
| teams-api interactive/browser token capture | Candidate reuse after source/package/tenant validation; avoid high-level automatic storage/refresh wrappers that conflict with bridge policy |
| teams-api message parser and types | Candidate helper reuse with runtime validation; missing IDs must not become accepted records |
| OpenClaw 2026.9.6 Chat Completions | Dedicated-agent HTTP request and stable conversation user; endpoint must be enabled, authenticated and loopback/private |
| Node fetch/AbortController | Use built-in cancellation/deadlines, rather than timeout races that leave requests alive |
| SQLite transactions and unique indexes | Durable queue, cursor and dedup in one database; no separate queue infrastructure |
| GitHub Actions/npm packaging | Existing ecosystem for CI/tagged CLI distribution; no new hosting service |

Version-specific [OpenClaw documentation](https://github.com/openclaw/openclaw/blob/v2026.9.6/docs/gateway/openai-http-api.md) verifies endpoint availability, enablement, agent targeting and stable `user` sessions. Installed-host configuration has not been read. Candidate [client source](https://github.com/Maxim-Mazurok/teams-api) was reviewed on main, not yet pinned/installed; verify source/package correspondence before implementation. These are source findings, not tenant-test results.

## Architecture Review

1. **P1, confidence 8/10: EC2 authentication path undefined.** Original design required testing an interactive display/credential store; candidate cache discards tokens after 23 hours. That does not establish actual tenant renewal intervals. Decision 2A: co-locate bridge with OpenClaw on EC2, use a private SSH/SSM browser-access path, test login/restart/renewal, and use Gateway loopback. Host OS/architecture still must be discovered.
2. **P1, confidence 9/10: silent credential-store fallback conflicts with policy.** Candidate `credential-store.ts:240-249` falls through from keyring failure to file writes. Decision 3A: explicit protected-file mode, dedicated user, 0700 directory/0600 files, operator-approved EBS storage, validated storage policy and no silent fallback. Service user/root can read credentials; do not describe file modes as encryption.
3. **P1, confidence 9/10: library owns timeout/retry behavior.** Candidate `api/common.ts:60-75` calls `fetch(input, init)` and retries 429 internally; send uses that helper. Decision 4A: bridge-owned small HTTP adapter with abortable requests, bounded classified retries, checked paging links and structured outcomes. No automatic repeat of ambiguous writes; do not fork or rebuild the whole client.

The accepted dedicated-agent trust boundary remains mandatory. Shared-secret OpenClaw turns carry operator authority; per-chat sessions are not tool/filesystem/memory access controls. Only grant senders the dedicated agent capabilities suitable for all allowed participants.

```text
Operator --private SSH/SSM--> EC2 browser sign-in
                                  |
                             protected credentials
                                  |
Teams <-- bounded HTTP adapter --> ingest/validate/policy
                                           |
                                  SQLite jobs + cursor
                                           |
                                  per-chat ordered worker
                                           |
                           loopback OpenClaw dedicated agent
                                           |
                               saved reply parts --> Teams
```

## Code Quality Review

4. **P1, confidence 9/10: malformed-message outcome missing.** Candidate `api/chat-service.ts:624` contains `String(raw.id ?? "")`; accepting an empty ID breaks a stable dedup contract. Decision 5A: validate message and paging schemas before routing; malformed input pauses its chat without advancing its cursor. Known unsupported system events may be ignored; unknown malformed records may not be silently discarded. Share normalized-message/error definitions across adapter, router and store.

No implementation exists, so this review does not claim measured duplication, dead code, tested behavior or stale code comments. Keep the production logic in ordinary modules with explicit contracts. Small pure formatting/policy helpers do not require class hierarchies or plugins.

## Test Review

5. **P1, confidence 8/10: recovery criteria lack executable assertions.** The original design specified fault injection but not detailed transition outcomes. Decision 6A: deterministic TypeScript tests, fake clocks, real temporary SQLite, local HTTP endpoints, process crash injection and separately authorized live tenant tests. Ten high-level flow areas had no executable coverage; concrete requirements now cover them in [engineering-test-plan.md](engineering-test-plan.md). No regression was found because no prior implementation exists.

```text
CODE PATH                                      USER FLOW
config/credential check --bad--> refuse         fix setup; no network first
login --cancel/expiry/mismatch--> needs-login   sign in again [E2E]
pages --bad/gap--> pause, preserve cursor        diagnose isolated chat
pages --overlap/new--> validate                 old ignored; new retained
policy --denied/self/no trigger--> ignore        no unintended replies
policy --allowed--> atomic enqueue              DM/group reaches queue
invoke --response--> save --split--> send        correct chat [E2E]
invoke/send --ambiguous--> uncertain             resolve without auto-repeat
restart --in-flight--> uncertain                inspect/cancel/explicit retry [E2E]
restart --response saved--> send only            no repeated agent run
cleanup --age reached--> purge body              IDs/status remain
scheduler --budget/throttle--> defer fairly      busy group doesn't starve DM
```

Actual coverage: not measurable yet; tests not generated or run in this review. The test-plan matrix maps each flow to failure handling, required assertions and operator-visible status. Critical silent gaps remaining in the plan: zero. Runtime handling remains unimplemented. Bridge envelope/output-routing checks are deterministic; no model-quality claim or system-prompt change is part of this review.

## Performance Review

6. **P2, confidence 8/10: fixed chat intervals lack an account request budget.** Original design polls every chat every five seconds; 20 chats yield 240 reads/minute before paging/discovery/sends. Decision 7A: one in-process scheduler with budgeted fair polling, bounded reply priority, at most two in-flight Teams requests by default and account-wide backoff. Use indexed database lookups, bounded page scans and batched cleanup. Latency target applies only inside the configured load budget; report saturation.

## NOT in scope

- Azure Bot, Entra registration, Teams app installation: unavailable to this operator.
- Browser UI automation as a second transport: only reconsider if the candidate transport fails validation.
- Channels, files, voice, reactions, proactive messages and responding to edited messages: approved first-release text-chat scope.
- Docker/image distribution: approved P3 follow-up in [TODOS.md](../TODOS.md), blocked on native EC2 authentication tests.
- Public Gateway or browser-control endpoints: use loopback/private access.
- Distributed workers, multi-host failover and hosted dashboards: single-host state suffices for this deployment.
- General multi-user resource authorization or personal-agent exposure: approved dedicated-agent trust boundary; native channel parity is not claimed.
- Public publishing during this review: distribution design only, credentials/npm namespace still need operator setup.

## Failure Modes

Detailed path-by-path matrix is in the test plan. Every planned path has tests and local error/status handling specified. Most important: ambiguous agent invocation or Teams delivery pauses that chat and requires reconciliation; expiry preserves queued work; malformed input preserves cursor; disk failure blocks cursor advancement; revoked access prevents invocation/sending. HTTP cancellation is local cancellation and does not prove a submitted external side effect was canceled.

Inline ASCII diagram comments should accompany the ingestion cursor transaction, worker state transitions and scheduler fairness rules in their implementation modules. Tests should diagram non-obvious crash injection boundaries. Keep these diagrams aligned with code changes.

```text
queued -> invoking -> response_ready -> sending(part N) -> sent
            |                              |
            +-- timeout/crash -> uncertain <-+
                                 |
                 operator mark complete/cancel/explicit retry
                                 |
                     durable resolution, then resume chat
```

## Worktree Parallelization Strategy

This is an implementation strategy, not authorization to launch agents or create worktrees now. Transport feasibility must run sequentially before other production modules depend on its contracts.

| Step | Modules touched | Depends on |
|---|---|---|
| Transport experiment and EC2 login | experiment/, adapters/teams/ | Host access and operator sign-in |
| Normalize shared contracts | core/ | Validated transport shapes |
| Teams adapter and storage mode | adapters/teams/, auth/ | Contracts |
| Policy and content normalization | policy/ | Contracts |
| Durable store and worker | persistence/, worker/ | Contracts |
| OpenClaw adapter | adapters/openclaw/ | Contracts, endpoint validation |
| Scheduler/CLI and service integration | scheduling/, cli/, service/ | All adapter/store/policy lanes |
| Live tests and packaging | acceptance/, docs/, .github/ | Integrated service |

Lane A: experiment → shared contracts (sequential prerequisites).
Lane B: Teams adapter/auth. Lane C: policy/content. Lane D: store/worker. Lane E: OpenClaw adapter. B–E can proceed independently after A if contracts stay fixed.
Lane F: scheduler/CLI integration → acceptance/package (waits for B–E).

Potential conflicts: shared contracts, package.json/lockfile, central test config and public docs should have one owner; adapter-local tests stay with their lane. Proposed file paths below are illustrative and may be consolidated without changing boundaries.

## Implementation Tasks

Synthesized from accepted findings. Suggested commands are targets to create during implementation, not existing runnable scripts.

- [ ] **T1 (P1, human: ~½–1 day / agent-assisted: ~1–3 hours)** — EC2 authentication — Prove interactive login, persistence and renewal on the intended host.
  - Surfaced by: Architecture finding 1 / 2A; Step 0 staging / 1A.
  - Files: experiment/transport-check.ts, docs/deployment.md, docs/compatibility.md.
  - Verify: operator browser sign-in; uniquely resolved authorized DM test; designated group tests; reboot and beyond-cache-window acceptance.
- [ ] **T2 (P1, human: ~2–4 hours / agent-assisted: ~30–60 minutes)** — Credentials — Implement explicit protected-file storage and safe account identity handling.
  - Surfaced by: Architecture finding 2 / 3A.
  - Files: src/auth/credentials.ts, src/config.ts, tests/credentials.test.ts.
  - Verify: permission/ownership/symlink/atomic-write tests; operator-approved volume and dedicated-user deployment checks.
- [ ] **T3 (P1, human: ~½–1 day / agent-assisted: ~1–3 hours)** — Teams requests — Implement bounded cancellable reads/sends with structured outcomes.
  - Surfaced by: Architecture finding 3 / 4A.
  - Files: src/adapters/teams/http.ts, src/adapters/teams/index.ts, tests/teams-contract.test.ts.
  - Verify: local HTTP tests for abort, redirect/pagination credentials, rejection/throttle and ambiguous delivery; verify reviewed package exports/version.
- [ ] **T4 (P1, human: ~2–4 hours / agent-assisted: ~30–60 minutes)** — Ingestion — Validate events and pause malformed chats without cursor advancement.
  - Surfaced by: Code quality finding 4 / 5A.
  - Files: src/core/contracts.ts, src/ingestion.ts, tests/ingestion.integration.test.ts.
  - Verify: empty IDs, bad timestamps/mention data, malformed pages and supported system event fixtures; zero unintended agent calls.
- [ ] **T5 (P1, human: ~1–2 days / agent-assisted: ~3–6 hours)** — Recovery tests — Implement the approved branch assertions with real persistence/process/HTTP failures alongside service features.
  - Surfaced by: Test finding 5 / 6A; ten uncovered planned flow areas.
  - Files: tests/, src/persistence/, src/worker/, docs/engineering-test-plan.md.
  - Verify: deterministic full suite, crash/restart integration, installed CLI/archive checks and opt-in live acceptance; no automatic repeat of uncertain effects.
- [ ] **T6 (P2, human: ~½ day / agent-assisted: ~1–2 hours)** — Scheduling — Add account request budget, fair paging and bounded priority.
  - Surfaced by: Performance finding 6 / 7A.
  - Files: src/scheduling/index.ts, tests/scheduler.test.ts, tests/scheduler.integration.test.ts.
  - Verify: busy group + quiet DM, budget saturation, throttling, shutdown and multi-turn/restarted scan tests; indexed queries and bounded memory.

## Completion Summary

- Step 0: full modular scope retained; transport validation staged first (1A).
- Architecture: 3 findings, all decisions accepted (2A, 3A, 4A).
- Code quality: 1 finding accepted (5A).
- Tests: diagram produced; 10 high-level unimplemented coverage areas mapped into a concrete test plan (6A). No test pass claimed.
- Performance: 1 finding accepted (7A).
- NOT in scope and existing reuse: written.
- TODOs: 1 proposed and accepted (8A), Docker follow-up captured.
- Failure modes: zero unresolved silent gaps in the plan; runtime validation still pending.
- Outside voice: fresh-context independent reviewer ran after user approval (9A), PASS with no new actionable issues. This was independent context, not a claimed different-model review.
- Parallelization: 6 lanes, B–E independent after A; A/F sequential prerequisites/integration.
- Lake score: 4/4 coverage decisions chose the complete option (4A, 5A, 6A, 7A); architecture/storage choices unscored by kind.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---|---|---|
| Eng Review | /plan-eng-review | Architecture, quality, tests, performance | 1 | CLEAR (PLAN) | 6 finding groups; 10 coverage areas specified |
| Design document adversarial review | /office-hours | Independent document audit | 2 rounds | PASS at design stage | Three design gaps fixed; not an engineering-runtime check |
| Outside Voice | User-approved independent reviewer | Independent plan opinion | 1 | PASS | No new actionable issues |

**VERDICT:** ENG CLEARED at plan stage; ready for the staged transport experiment once host/sign-in access is available. This is not runtime, test-success or release evidence. EC2 host identifier and designated group remain operational inputs, not unresolved architecture decisions. No test messages have been sent.

NO UNRESOLVED DECISIONS
