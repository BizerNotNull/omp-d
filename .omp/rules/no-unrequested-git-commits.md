---
name: no-unrequested-git-commits
description: "Do not prepare or create Git commits unless the user explicitly requests a commit."
condition: "\\bcommit\\.draft\\s*\\(|\\b[A-Za-z_$][\\w$]*\\.commit\\s*\\("
scope: "tool"
---

Before preparing or creating a Git commit, check that the user explicitly requested a commit. A request to update a file does not authorize committing it. Without an explicit commit request, leave the changes uncommitted, perform the relevant verification, and report the result. Do not add a commit step to the task plan by default.