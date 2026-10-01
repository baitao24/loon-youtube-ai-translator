# Third-party notices

## DualSubs

Versions up to 0.5.0 loaded the unmodified `DualSubs/YouTube` v1.5.11 request
and response release bundles for YouTube player interception, and versions
0.3.x–0.4.x adapted the timestamp alignment of `DualSubs/Universal` v1.7.5.
Since 0.5.1 the plugin no longer loads or includes any DualSubs code: it only
intercepts the timedtext subtitle endpoint so it can coexist with YouTube
ad-block plugins.

Copyright belongs to the respective DualSubs contributors. Those repositories
are published under the Apache License 2.0.

Project links:

- https://github.com/DualSubs/YouTube
- https://github.com/DualSubs/Universal

A copy of the upstream Apache License 2.0 is included at
`LICENSES/Apache-2.0.txt`.
