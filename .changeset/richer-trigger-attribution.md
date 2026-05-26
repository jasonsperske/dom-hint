---
bump: minor
---

Add richer trigger attribution with fetch/XHR interception, timer monkey-patching, and causal chain tracking. Network tracking (on by default) records fetch/XHR completions and attributes subsequent mutations to the request. Timer patching (opt-in, invasive) wraps setTimeout/setInterval to track delayed mutations. Both preserve a link to the originating user event, enabling causal chain output like "click on button#save → fetch POST /api → [added] div.toast".
