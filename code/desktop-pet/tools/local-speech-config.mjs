// Compatibility shim: the transactional editor now lives in providers/configuration-edit.ts so the
// management server can apply a console-submitted change through the same lock, backup and rollback
// path the CLIs use. Kept so existing tools keep importing this filename.
export { updateProviderConfiguration, updateProviderConfiguration as updateSpeechConfiguration } from '../dist/providers/configuration-edit.js';
