---
bump: minor
---

Add configurable mutation tracking: users can now enable/disable observation of element inserts & deletes, attribute changes, and text content changes from the popup. Defaults to element inserts & deletes only (preserving existing behavior). Settings persist via chrome.storage.sync.
