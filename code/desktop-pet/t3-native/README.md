# T3 native UI overlay

The exact fixed upstream application provides the router, state, client, chat and engineering components. These files are the registered source overlays. SOURCE.json pins the untouched input bytes. Build preparation assembles an isolated copy under artifacts/runtime and overlays these paths; generated source and output are not installed.

Use Node 24.13.1 and the cached dependencies from the fixed source. The first UI preview uses isolated fixture input through original state and components. Every transport mutation is rejected. Real auth/API/device acceptance is separate.
