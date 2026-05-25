# Changesets

To trigger a version bump and release, add a `.md` file to this directory on your feature branch before merging.

## File format

The filename can be anything (e.g., `add-tooltip-fix.md`). The content must have frontmatter with a `bump` field:

```md
---
bump: patch
---

Fixed tooltip positioning on narrow viewports.
```

### Bump types

| Type | When to use | Example |
|---|---|---|
| `patch` | Bug fixes, small tweaks | `1.0.0` → `1.0.1` |
| `minor` | New features, non-breaking changes | `1.0.0` → `1.1.0` |
| `major` | Breaking changes | `1.0.0` → `2.0.0` |

If no `.changeset/*.md` file (other than this README) is present in the merge, the build still runs but no version bump or release is created.
