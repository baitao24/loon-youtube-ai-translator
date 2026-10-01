# Third-party notices

## DualSubs

The YouTube player interception (caption track unlocking and automatic
captions) is provided by `DualSubs/YouTube`.

Copyright belongs to the respective DualSubs contributors. Those repositories
are published under the Apache License 2.0.

The generated Loon plugin loads the unmodified `DualSubs/YouTube` v1.5.11
request and response release bundles directly from the official GitHub release.
This repository does not redistribute those bundles or generated protobuf
sources.

Earlier versions (0.3.x–0.4.x) also adapted the timestamp alignment of
`DualSubs/Universal` v1.7.5 to merge YouTube's official translation. Since
0.5.0 that code has been removed, because YouTube now rejects official
translation requests; subtitles are translated by Gemini from the source track.

Project links:

- https://github.com/DualSubs/YouTube
- https://github.com/DualSubs/Universal

A copy of the upstream Apache License 2.0 is included at
`LICENSES/Apache-2.0.txt`.
