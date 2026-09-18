# Copilot exact-session live drive

## Config refuses reserved session flags
- --continue -> exit 1: gnhf: Invalid config value for agentArgsOverride.copilot[0]: "--continue" is managed by gnhf and cannot be overridden
- --resume -> exit 1: gnhf: Invalid config value for agentArgsOverride.copilot[0]: "--resume" is managed by gnhf and cannot be overridden
- --resume=0cb916db-26aa-40f2-86b5-1ba81b225fd2 -> exit 1: gnhf: Invalid config value for agentArgsOverride.copilot[0]: "--resume=0cb916db-26aa-40f2-86b5-1ba81b225fd2" is managed by gnhf and cannot be overridden
- -r -> exit 1: gnhf: Invalid config value for agentArgsOverride.copilot[0]: "-r" is managed by gnhf and cannot be overridden
- --session-id -> exit 1: gnhf: Invalid config value for agentArgsOverride.copilot[0]: "--session-id" is managed by gnhf and cannot be overridden
- --session-id=0cb916db-26aa-40f2-86b5-1ba81b225fd2 -> exit 1: gnhf: Invalid config value for agentArgsOverride.copilot[0]: "--session-id=0cb916db-26aa-40f2-86b5-1ba81b225fd2" is managed by gnhf and cannot be overridden

## Successful Copilot JSONL turn
- commit: gnhf 1: copilot mock wrote hello.txt
- hello.txt: "hello from copilot mock\n"
- mock flags: continue=false resume=false session-id=false
- exit summary:
│
│   copilot ran for 0s before: max iterations reached (1)    │
╰────────────────────────────────────────────────────────────╯

  iterations      1 total       1 good       0 failed
  tokens          11 total      4 in         7 out
  branch diff     1 commit      +1           -0
  files           1 added       0 updated    0 deleted

  notes           /tmp/gnhf-copilot-repo-O2RsYv/.gnhf/runs/add-a-hello-txt-via-51a8cc/notes.md
  debug log       /tmp/gnhf-copilot-repo-O2RsYv/.gnhf/runs/add-a-hello-txt-via-51a8cc/gnhf.log

  next steps      git log --oneline db54a1ec3f2e..HEAD
                  git diff --stat db54a1ec3f2e..HEAD

## Empty Copilot final (no recovery)
- mock spawns: 1
- mock flags: continue=false resume=false session-id=false
- gnhf.log error: CopilotEmptyTurnError: copilot returned no agent message
- notes: **Summary:** [ERROR] copilot returned no agent message
- exit summary:
│
│   copilot ran for 0s before: copilot returned no agent message │
╰────────────────────────────────────────────────────────────────╯

  iterations      1 total       0 good       1 failed
  tokens          0 total       0 in         0 out
  branch diff     0 commits     +0           -0
  files           0 added       0 updated    0 deleted

  notes           /tmp/gnhf-copilot-repo-vxYXFW/.gnhf/runs/summarize-the-change-f8aafc/notes.md
  debug log       /tmp/gnhf-copilot-repo-vxYXFW/.gnhf/runs/summarize-the-change-f8aafc/gnhf.log

  next steps      git log --oneline db54a1ec3f2e..HEAD
                  git diff --stat db54a1ec3f2e..HEAD

## CopilotAgent empty-turn session capture
- captured sessionId: 0cb916db-26aa-40f2-86b5-1ba81b225fd2
- spawns: 1; session-id passed: false

## CopilotAgent exact-session resume args
- argv head: ["--session-id","0cb916db-26aa-40f2-86b5-1ba81b225fd2","-p","You did not produce a final answer. Continue.\n\n## gnhf final output contract\n\nWhen the iteration is complete, your final answer must be a single JSON object that matches this JSON Schema:\n\n```json\n{\n  \"type\": \"object\",\n  \"additionalProperties\": false,\n  \"properties\": {\n    \"success\": {\n      \"type\": \"boolean\"\n    },\n    \"summary\": {\n      \"type\": \"string\"\n    },\n    \"key_changes_made\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"string\"\n      }\n    },\n    \"key_learnings\": {\n      \"type\": \"array\",\n      \"items\": {\n        \"type\": \"string\"\n      }\n    }\n  },\n  \"required\": [\n    \"success\",\n    \"summary\",\n    \"key_changes_made\",\n    \"key_learnings\"\n  ]\n}\n```\n\nReturn only the JSON object in the final answer. Do not wrap it in Markdown. Do not include explanatory prose outside the JSON object."]
- hasContinue=false hasResume=false sessionIdValue=0cb916db-26aa-40f2-86b5-1ba81b225fd2
