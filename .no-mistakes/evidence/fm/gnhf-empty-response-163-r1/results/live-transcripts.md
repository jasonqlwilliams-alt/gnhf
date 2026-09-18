# Live gnhf empty-response recovery

Drove `node dist/cli.mjs` against isolated temp git repos with protocol-faithful mocks.
All commands used `--prevent-sleep off` and an isolated `HOME`.

## OpenCode: empty first turn then recover

- Command: `gnhf "recover the empty turn" --agent opencode --max-iterations 1`
- Mock first turn: `session.idle` with no `final_answer`, plus a README edit
- Mock second turn: continuation prompt received, structured summary returned
- Exit: 0
- Exit summary: `iterations 1 total / 1 good / 0 failed`
- Commit subject: `gnhf 1: recovered after empty first turn`
- Debug: `opencode:output:missing` then `opencode:output:continuation` (attempt 1) then `iteration:end` success
- Same-session prompt 2: `You did not produce a final answer. Continue and provide your final summary now.`

## OpenCode: still empty after one continuation

- Command: `gnhf "empty twice should fail once" --agent opencode --max-iterations 1`
- Exit summary: `opencode ran for 1s before: OpenCode produced no final answer`
- `iterations 1 total / 0 good / 1 failed`
- `branch diff 0 commits` and a clean working tree (the empty-turn README edit was rolled back)
- Exactly two same-session prompts; error name `EmptyAgentResponseError`

## OpenCode: provider overload is not continued

- Command: `gnhf "provider error must not continue" --agent opencode --max-iterations 1`
- One prompt only; agent error `OpenCode provider overloaded`; no `opencode:output:continuation`

## OpenCode: interrupt during continuation

- First turn empty, second turn hung on the continuation prompt
- Double SIGINT while hung
- Exit code 130
- Debug: `opencode:output:continuation` then `orchestrator:stop-requested` then `opencode:run:aborted` / `iteration:stopped`
- No `iteration:end` failure and no recorded `OpenCode produced no final answer`

## Copilot: empty turn does not continue

- Command: `gnhf "copilot empty must fail immediately" --agent copilot --max-iterations 1`
- Mock `copilot` spawned once and emitted no `assistant.message`
- Agent error: `copilot returned no agent message`
- No continuation event and no second spawn

## ACP: empty first turn then recover

- Command: `gnhf "recover the empty acp turn" --agent acp:empty-target --max-iterations 1`
- First ACP prompt completed with no output text; second prompt was the continuation
- Exit summary: `1 good / 0 failed`, `branch diff 1 commit`
- Debug: `acp:output:continuation` attempt 1, then `iteration:end` success with summary `recovered after empty first turn`

## ACP: still empty after one continuation

- Command: `gnhf "acp empty twice should fail once" --agent acp:empty-target --max-iterations 1`
- Exactly two prompts; agent error `ACP agent returned no output text`
- No extra retry beyond the one continuation

## CLI help

- `gnhf --help` does not advertise a keep-failed-work / no-rollback flag
