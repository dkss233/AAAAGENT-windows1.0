# Device model provenance and distribution restriction

The adjacent `sources.json` identifies these device models as **Apple Inc.** assets and states: "No open-source or redistribution license has been established."

This provenance is also recorded in the [fixed T3 Code upstream source](https://github.com/pingdotgg/t3code/blob/c13f7d93fff0f578886985a3f673b4b21b7f6ac8/apps/web/src/components/device/models/sources.json). It records the Apple source URLs, source hashes and conversions; it does not grant redistribution permission.

The following files must be excluded from this AAAAGENT source release and its public release artifacts unless a separate, applicable authorization is established:

- `iphone-18-pro.glb`
- `iphone-18-pro-max.glb`
- `ipad-pro-13-m5.glb`
- `ipad-pro-13-m5-magic-keyboard.glb`
- `iphone-duo.glb`

T3 Code's root MIT license must not be represented as licensing these models. Conversion to GLB, texture resizing, public download availability, or inclusion in an upstream source tree does not establish a new grant from the asset owner. Use an appropriately licensed replacement or obtain explicit permission before distributing these device previews.

This notice and `sources.json` are retained for attribution and to explain why the media are omitted. They do not claim endorsement by Apple or T3 Tools Inc.
