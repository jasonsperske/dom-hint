---
bump: patch
---

Fixed the observer missing DOM and shadow-DOM changes from other extensions. The observer now roots at `<html>` so insertions directly under it (overlays, banners) are captured, and `Element.prototype.attachShadow` is patched while watching with shadow scope enabled so shadow roots attached later to pre-existing elements — including closed roots — are observed.
