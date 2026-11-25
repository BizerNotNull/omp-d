# Changelog

## Unreleased

### Added
- The composer can insert a typed local file path at the cursor as prompt text, without attaching the file

### Changed
- Long chats reuse settled transcript rows across streaming updates. The renderer also reuses its syntax highlighter and retains less parsed data for ordinary code blocks.