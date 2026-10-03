# Contributing

Use Node 24.12+, `npm ci --ignore-scripts`, and `npm run check`. Add synthetic fixtures only. Keep transport, policy, persistence and scheduling boundaries explicit; changing code that submits external actions requires crash/ambiguity coverage.

Do not add automatic replays of uncertain turns, silently change credential storage modes, or expose the Gateway/browser publicly. Validate candidate client changes against package source and repeat opt-in tenant tests. A short smoke test does not establish token renewal or continuous reliability.

The production sources are in `src/`; tests in `tests/`; the bounded feasibility tools in `experiment/`. Build outputs and tenant state are excluded from Git. Include documentation and compatibility changes with any behavioral change.
