---
name: exclude-debugging-screenshots
description: "Keep debugging screenshots out of commits."
condition: "\\.screenshot\\s*\\("
scope: "tool:eval"
---

Debugging screenshots are verification artifacts, not deliverables. Save them outside the repository. Never stage or commit them unless the user explicitly requests their inclusion.