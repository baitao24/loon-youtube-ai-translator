# Third-party notices

## DualSubs

The YouTube player interception, `Official` subtitle baseline, timestamp
alignment, and bilingual composition behavior are based on:

- `DualSubs/YouTube`
- `DualSubs/Universal`

Copyright belongs to the respective DualSubs contributors. Those repositories
are published under the Apache License 2.0.

The generated Loon plugin loads the unmodified `DualSubs/YouTube` v1.5.11
request and response release bundles directly from the official GitHub release.
This repository does not redistribute those bundles or generated protobuf
sources.

The local `composeOfficialSubtitles` implementation follows the timestamp
two-pointer alignment behavior of `DualSubs/Universal` v1.7.5, adapted to the
narrow YouTube JSON3 and srv3 paths and combined with this project's AI
translation, deadline, cache, and official-fallback logic.

Project links:

- https://github.com/DualSubs/YouTube
- https://github.com/DualSubs/Universal

A copy of the upstream Apache License 2.0 is included at
`LICENSES/Apache-2.0.txt`.
