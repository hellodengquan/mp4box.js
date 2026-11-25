---
'mp4box': patch
---

Resolve sample group descriptions to the box they actually come from. A `group_description_index` below 0x10000, or equal to 0x10000 plus an entry number above it, now selects the track's or the fragment's `sgpd` respectively, and samples that a fragment's `sbgp` does not cover (or a track that only declares a default description) use the default group description the applicable `sgpd` declares instead of keeping an unresolved index or throwing. Fragments that only carry `sgpd` (no `sbgp`) are now taken into account.
