# Changelog

## Unreleased

### Added
- Added `/plan [prompt]` and `/plan-review` to inspect the workspace with a restricted toolset, edit the proposed plan, and approve it before execution. Planning state follows the session across switches and restarts
- Plan review can select an execution model and start fresh, compact the conversation, or keep its context. Planning uses the configured `plan` model role and can autosave approved plans as Markdown
- Added `/new`, `/resume`, and `/restart` to the desktop composer
- Drop files onto the composer to reference their original paths. PNG, JPEG, GIF, and WebP files become image attachments when readable within the per-drop limit; otherwise their paths are inserted. Image-only drafts can be sent

### Changed
- Session, project, Worktree, model, and settings search fields use the same compact style with a thinner border
- Text fields, including Extra arguments, keep a thin border when focused
- Agent request submit buttons use the same compact arrow-button style as the composer
- Slash completion includes aliases and subcommands advertised by omp. Known TUI-only commands without a desktop handler stay in the composer instead of being sent to the model