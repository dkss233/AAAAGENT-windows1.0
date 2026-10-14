import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

// Public source distributions omit the licensed SDK and private preset catalog.
// Select the real implementation only when its direct build inputs are present;
// malformed installed resources still fail the normal build/runtime validation.
const required = [
  './assets/jellyfish/presets.json',
  './vendor/cubism/Core/live2dcubismcore.min.js',
  './vendor/cubism/Framework/src/live2dcubismframework.ts',
  './vendor/cubism/Framework/src/model/cubismusermodel.ts',
  './vendor/cubism/Framework/src/cubismmodelsettingjson.ts',
  './vendor/cubism/Framework/src/math/cubismmatrix44.ts',
  './vendor/cubism/Framework/src/effect/cubismeyeblink.ts',
  './vendor/cubism/Framework/src/motion/cubismexpressionmotionmanager.ts',
  './vendor/cubism/Framework/src/rendering/cubismshader_webgl.ts',
];

export async function optionalLive2dBuild() {
  const missing = [];
  for (const relative of required) {
    try {
      if (!(await stat(new URL(relative, import.meta.url))).isFile()) missing.push(relative);
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      missing.push(relative);
    }
  }
  const available = missing.length === 0;
  const unavailable = fileURLToPath(new URL('./live2d-unavailable.mjs', import.meta.url));
  if (!available) console.warn('Live2D resources are not installed; building the desktop shell without Live2D. Install licensed resources and rebuild to enable it.');
  return {
    available,
    previewEntry: fileURLToPath(new URL(available ? './presentation-preview.mjs' : './live2d-unavailable.mjs', import.meta.url)),
    plugins: available ? [] : [{
      name: 'optional-live2d',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/cubism-renderer\.mjs$/ }, () => ({ path: unavailable }));
      },
    }],
  };
}
