const message = 'Live2D 资源或 SDK 未安装。请准备有权使用的模型、预设和 SDK 后重新构建；当前仍可使用文字界面或已安装的视频桌宠。';
function unavailableError() {
  const error = new Error(message);
  error.code = 'LIVE2D_RESOURCES_MISSING';
  return error;
}

// Fail explicitly instead of drawing a substitute or reporting model readiness.
export class JellyfishRenderer {
  constructor() { this.ready = false; }
  async load() { throw unavailableError(); }
  dispose() { this.ready = false; }
}

export async function createPresentationPreview({ onStatus = () => {} } = {}) {
  onStatus({ state: 'error', message, presetId: null });
  throw unavailableError();
}
