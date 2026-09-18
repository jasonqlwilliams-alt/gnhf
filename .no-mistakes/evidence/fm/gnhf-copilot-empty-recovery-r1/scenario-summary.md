# Live gnhf Copilot empty-final recovery

Drove the real built CLI: `node dist/cli.mjs --agent copilot --max-iterations 1 --current-branch --prevent-sleep off`
in isolated git repos with `agentPathOverride.copilot` pointing at a JSONL-protocol Copilot stand-in
(empty finals are not a deterministic GitHub Copilot CLI behavior).

## Recover
- First spawn: no `--session-id`, no `--continue` / `--resume`
- Logged `copilot:output:continuation` with session `0cb916db-26aa-40f2-86b5-1ba81b225fd2`
- Second spawn: `--session-id 0cb916db-26aa-40f2-86b5-1ba81b225fd2` plus the continuation prompt
- Exit card: 1 good / 0 failed, 1 commit
- notes.md: recovered empty Copilot final via --session-id

## Still-empty retry
- Same exact-session resume, then original failure kept
- Exit card: 0 good / 1 failed, 0 commits
- notes.md: [ERROR] copilot returned no agent message

## No session id
- One spawn only; no `--session-id`, `--continue`, or `--resume`
- notes.md: [ERROR] copilot returned no agent message

## Provider error
- One spawn only; no continuation
- notes.md: [ERROR] copilot exited with code 1: login required

## Interrupt during continuation
- Second spawn used `--session-id`; two SIGINTs
- gnhf.log: graceful-stop then stop-requested, agent:run:stopped, no empty-failure note
- Exit code 130
