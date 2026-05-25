---
bump: minor
---

Add structured/filterable output: mutations are now logged with console.groupCollapsed (summary line + expandable detail), a configurable max HTML length for flat output, and a CSS selector filter to scope observation to specific elements. All settings are configurable from the popup and persist via chrome.storage.sync.
