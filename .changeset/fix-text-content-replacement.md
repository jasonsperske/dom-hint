---
bump: patch
---

Fix text change tracking not capturing `el.textContent = "..."` assignments. Setting textContent replaces child nodes (a childList mutation with text nodes), which was silently ignored since the childList handler only processed element nodes. Now logs text node additions as [text+] and removals as [text-] when characterData tracking is enabled.
