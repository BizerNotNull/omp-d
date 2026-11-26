---
name: back-button-at-page-top-left
description: "Keep the back button at the top-left of the page, outside the shared window title bar."
condition: "<WindowTitleBar(?:\\s|>)(?:(?!</WindowTitleBar>)[\\s\\S])*?aria-label=\"Back(?: (?:from|to) [^\"]+)?\""
scope: ["tool:edit(*.tsx)", "tool:write(*.tsx)"]
---

Place the back button in the page’s own header, at the top-left of the page content, before the page title. Keep it outside `WindowTitleBar` and out of any horizontally centered or right-aligned group. The shared title bar remains for window-level controls.