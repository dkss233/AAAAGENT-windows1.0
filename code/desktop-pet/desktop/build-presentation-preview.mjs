import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {optionalLive2dBuild} from './optional-live2d-build.mjs';
const {previewEntry:entry}=await optionalLive2dBuild();
await build({entryPoints:[entry],bundle:true,format:'esm',platform:'browser',target:'safari17',outfile:fileURLToPath(new URL('../management/ui/presentation-preview.js',import.meta.url)),legalComments:'eof'});
