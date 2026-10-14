import { InteractionMotion } from './interaction-motion.mjs';
import { normalizePresentationIntent } from '../contracts/presentation.ts';
import { ModelFeather } from './model-feather.mjs';
import presetCatalog from './assets/jellyfish/presets.json';
// Application adapter over the official SDK; SDK owns deformation, physics, blending and WebGL rendering.
import { CubismFramework } from './vendor/cubism/Framework/src/live2dcubismframework.ts';
import { CubismUserModel } from './vendor/cubism/Framework/src/model/cubismusermodel.ts';
import { CubismModelSettingJson } from './vendor/cubism/Framework/src/cubismmodelsettingjson.ts';
import { CubismMatrix44 } from './vendor/cubism/Framework/src/math/cubismmatrix44.ts';
import { CubismEyeBlink } from './vendor/cubism/Framework/src/effect/cubismeyeblink.ts';
import { CubismBreath } from './vendor/cubism/Framework/src/effect/cubismbreath.ts';
import { CubismExpressionMotionManager } from './vendor/cubism/Framework/src/motion/cubismexpressionmotionmanager.ts';
import { CubismShaderManager_WebGL } from './vendor/cubism/Framework/src/rendering/cubismshader_webgl.ts';


const presets = new Map(presetCatalog.items.map(item => [item.id, item]));
const automaticItems = presetCatalog.items.filter(item => item.availability === 'automatic');
const shippedFaces = new Map(automaticItems.flatMap(item => (item.emotions ?? []).map(key => [key, item])));
const gestures = new Map(automaticItems.flatMap(item => (item.gestures ?? []).map(key => [key, item])));
/** Emotion → preset, resolved per policy. The operator's live assignments win over the catalog's
 *  shipped ones, and an assigned preset stays eligible even when it is not marked automatic. */
function resolveFaces(policy) {
  const map = new Map(shippedFaces);
  const hidden = new Set(Array.isArray(policy?.hiddenIds) ? policy.hiddenIds : []);
  for (const [emotion, item] of [...map]) if (hidden.has(item.id)) map.delete(emotion);
  const assigned = policy?.emotions;
  if (!assigned || typeof assigned !== 'object') return map;
  for (const [emotion, id] of Object.entries(assigned)) {
    if (hidden.has(id)) continue;
    const item = presets.get(id);
    if (item?.expressionName) map.set(emotion, item);
  }
  return map;
}
const headParameters = ['ParamAngleX2', 'ParamAngleX3', 'ParamAngleX4'];
const interactionParameters = [...headParameters, 'ParamBodyAngleX', 'ParamEyeBallX', 'ParamEyeBallY'];
// Idle-animation intensity. These are the only knobs that decide how strongly the rig
// moves on its own: headAngleScale drives the 33 angle-based physics chains, and the
// breath pair drives the 10 breath-based ones (hair, skirt, tail, arms, body).
// Raise headAngleScale for more head/hair swing, breathPeak for deeper breathing.
export const MOTION_TUNING = {
  headAngleScale: 30,   // degrees applied per unit of interaction yaw/pitch/roll
  headAngleLimit: 30,   // hard clamp in degrees (model's ParamAngle* range is +/-30)
  bodyAngleScale: 1,    // multiplier on the deliberate body sway layer
  breathPeak: 0.5,      // ParamBreath swing amplitude about breathOffset
  breathOffset: 0.5,    // ParamBreath centre (model range 0..1 -> centre 0.5)
  breathCycle: 2.5,       // seconds per full breath
};
const webglOwners = new Set();
export class JellyfishRenderer extends CubismUserModel {
  constructor(canvas, report = () => {}, options = {}) {
    super(); this.canvas = canvas; this.report = report; this.options = options;
    this.textures = []; this.expressions = new Map(); this.faceKey = ''; this.gestureKey = '';
    // Rebuilt whenever a presentation policy arrives, so emotion assignments take effect live.
    this.faces = new Map(shippedFaces);
    // Expression names the operator marked "隐藏", and the value each is forced to.
    this.hiddenExpressions = new Set();
    this.hiddenValues = new Map();
    this.hiddenOverrides = new Map();
    this.expressionParameterIds = new Map();
    this.expressionParameters = new Set(); this.expressionValues = new Map(); this.previewParameters = new Set(); this.appearanceParameters = new Set();
    this.interaction = new InteractionMotion(); this.elapsed = 0; this.gestureManager = new CubismExpressionMotionManager(); this.previewManager = new CubismExpressionMotionManager(); this.framing = 'full';
    // User-controlled wheel zoom. 1 = the framing preset's own baseline scale; the
    // projection multiplies it, so 'full'/'half' keep working unchanged.
    this.modelZoom = 1;
    // Movement-mode offset, as a fraction of canvas width so dragging tracks the pointer at
    // any zoom. Applied as a projection translation: it moves the model without scaling it.
    this.modelOffsetX = 0; this.modelOffsetY = 0;
    // Movement-mode zoom scales the element with a CSS transform, which would stretch a
    // fixed-size backing store and look soft. This raises the canvas resolution to match.
    this.resolutionScale = 1;
    this.breath = CubismBreath.create();
    // No policy yet means no automatic animation, including before backend ready.
    this.automaticIds = new Set(); this.policyRevision = -1; this.previewValues = new Map();
  }
  async load() {
    this.gl = this.canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true });
    if (!this.gl) throw new Error('这个窗口无法启用 WebGL');
    this.syncViewport();
    const base = new URL(this.options.assetBase ?? 'assets/jellyfish/', location.href);
    const read = async path => { const r = await fetch(new URL(path, base)); if (!r.ok && r.status !== 0) throw new Error(`模型文件加载失败：${path}`); return r.arrayBuffer(); };
    await this.loadRig(read);
    this.createRenderer(this.canvas.width, this.canvas.height);
    webglOwners.add(this);
    const renderer = this.getRenderer(); renderer.startUp(this.gl); renderer.loadShaders(new URL(this.options.shaderBase ?? 'vendor/cubism/Framework/Shaders/WebGL/', location.href).href); renderer.setIsPremultipliedAlpha(true);
    for (let i = 0; i < this.settings.getTextureCount(); i++) {
      const img = new Image(); img.src = new URL(this.settings.getTextureFileName(i), base).href; await img.decode();
      if (Math.max(img.width, img.height) > this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE)) throw new Error('设备不支持这张模型纹理的尺寸');
      const gl = this.gl, tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex); gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE); renderer.bindTexture(i, tex); this.textures.push(tex);
    }
    this._modelMatrix.setHeight(1.9); this._modelMatrix.setPosition(0, 0);
    this.syncViewport(true);
    this.report({ type: 'model-loaded', parameters: this._model.getParameterCount(), drawables: this._model.getDrawableCount(), expressions: this.expressions.size, textures: this.textures.length, canvas: [this._model.getCanvasWidth(), this._model.getCanvasHeight()], maxTextureSize: this.gl.getParameter(this.gl.MAX_TEXTURE_SIZE), runtime: 'Cubism5-r.5' });
    this.ready = true; this.last = performance.now();
  }
  // Shared by the real WebGL loader and silent tests of the actual Cubism rig.
  async loadRig(readAsset) {
    CubismFramework.startUp({ logFunction: message => this.report({ type: 'sdk', message }), loggingLevel: 3 }); CubismFramework.initialize();
    const buffers = new Map();
    const read = async path => {
      if (typeof path !== 'string' || /^[/.]|[:%\\]/.test(path) || path.split('/').includes('..')) throw new Error('模型资源路径不可用');
      if (!buffers.has(path)) buffers.set(path, await readAsset(path));
      return buffers.get(path);
    };
    const settingsBuffer = await read('pet.model3.json');
    const refs = JSON.parse(new TextDecoder().decode(settingsBuffer)).FileReferences;
    const motionRefs = refs.Motions ? Object.values(refs.Motions).flat().map(m => m.File) : [];
    const paths = [...new Set(['pet.model3.json', refs.Moc, refs.Physics, ...refs.Expressions.map(e => e.File), ...motionRefs])].sort();
    const hash = async buffer => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer)), byte => byte.toString(16).padStart(2, '0')).join('');
    let binding = '';
    for (const path of paths) binding += path + '\0' + await hash(await read(path)) + '\n';
    const fingerprint = await hash(new TextEncoder().encode(binding));
    if (fingerprint !== presetCatalog.modelFingerprint) throw new Error('模型与预设目录版本不一致');
    this.settings = new CubismModelSettingJson(settingsBuffer, settingsBuffer.byteLength);
    this.loadModel(await read(this.settings.getModelFileName()), true);
    if (!this._model) throw new Error('Cubism 未能解析模型');
    const physics = await read(this.settings.getPhysicsFileName()); this.loadPhysics(physics, physics.byteLength);
    this.blink = CubismEyeBlink.create(this.settings);
    this.parameterIndices = new Map(Array.from(this._model.getModel().parameters.ids, (id, i) => [id, i]));
    // Parameters each expression drives, so an operator can neutralise an unwanted one (a rig's
    // author watermark, for example) by holding its parameters at the expression's own value.
    this.expressionParameterIds = new Map();
    this.expressionParameterValues = new Map();
    // This rig declares an EMPTY EyeBlink group, so CubismEyeBlink.create() collected zero
    // parameters and blinks nothing. The model does expose the standard open/close
    // parameters, so register them directly (the field is public in the framework).
    for (const id of ['ParamEyeLOpen', 'ParamEyeROpen']) if (this.parameterIndices.has(id)) this.blink._parameterIds.push(CubismFramework.getIdManager().getId(id));
    // Standard Cubism breath binding: ParamBreath cycles 0 -> 1 -> 0 roughly every
    // 3.2 s, which this rig's physics settings (24, 26, 38-45) consume as input.
    if (this.parameterIndices.has('ParamBreath'))
      this.breath.setParameters([{ parameterId: CubismFramework.getIdManager().getId('ParamBreath'), offset: MOTION_TUNING.breathOffset, peak: MOTION_TUNING.breathPeak, cycle: MOTION_TUNING.breathCycle, weight: 1 }]);
    const supported = new Set(automaticItems.map(item => item.expressionName));
    const appearance = new Set(presetCatalog.items.filter(item => item.category === 'appearance').map(item => item.expressionName));
    for (let i = 0; i < this.settings.getExpressionCount(); i++) {
      const name = this.settings.getExpressionName(i), b = await read(this.settings.getExpressionFileName(i));
      this.expressions.set(name, this.loadExpression(b, b.byteLength, name));
      // Record which parameters this expression drives, so a hidden expression can be forced to a
      // neutral value. Mouth amplitude and the legacy author switch are never expression-driven.
      const driven = [];
      const values = new Map();
      for (const parameter of JSON.parse(new TextDecoder().decode(b)).Parameters) {
        if (!this.parameterIndices.has(parameter.Id)) throw new Error('预设引用了模型不存在的参数');
        if (parameter.Id !== 'ParamMouthOpenY' && parameter.Id !== 'fase80') {
          driven.push(parameter.Id);
          values.set(parameter.Id, Number.isFinite(parameter.Value) ? parameter.Value : 0);
        }
        if (parameter.Id === 'ParamMouthOpenY' || parameter.Id === 'fase80') continue;
        this.previewParameters.add(parameter.Id);
        if (supported.has(name)) this.expressionParameters.add(parameter.Id);
        if (appearance.has(name)) this.appearanceParameters.add(parameter.Id);
      }
      this.expressionParameterIds.set(name, driven);
      this.expressionParameterValues.set(name, values);
    }
    // Rigs without bundled motion files are supported; the model then holds its
    // expression pose instead of a looping idle motion.
    const idleFile = this.settings.getMotionCount('Idle') > 0 ? this.settings.getMotionFileName('Idle', 0) : '';
    this.motionParameters = new Set();
    if (idleFile) {
      const motion = await read(idleFile); this.idle = this.loadMotion(motion, motion.byteLength, 'Idle'); this.idle.setLoop(true); this.idle.setEffectIds([], []);
      this.motionParameters = new Set(JSON.parse(new TextDecoder().decode(motion)).Curves.filter(c => c.Target === 'Parameter').map(c => c.Id));
    }
    // Only parameters this rig actually declares: historical rigs use ParamMouthForm2
    // and ParamAngleX2/X3/X4, while simpler rigs ship only the base set. The adapter
    // drives whatever is present instead of refusing to load the model.
    this.runtimeParameters = new Set([...this.expressionParameters, ...this.motionParameters, ...interactionParameters, 'ParamBodyAngleX', 'ParamEyeLOpen', 'ParamEyeROpen', 'ParamMouthForm2', 'ParamMouthOpenY']
      .filter(id => this.parameterIndices.has(id)));
    for (const id of this.runtimeParameters) { this.previewParameters.add(id); this.appearanceParameters.delete(id); }
    // Asset-author switch: hide the preview watermark; source model and textures stay intact.
    // Asset-author switch: hide the legacy preview watermark; source model and textures stay intact.
    this.set('fase80', 1); this._model.update();
    this.hiddenOverrides = new Map();
    this.defaults = Array.from(this._model.getModel().parameters.values);
    // Per-parameter baseline the rig loaded with, captured before any expression or motion runs.
    // Hidden expressions are re-applied against this baseline on every frame, because the render
    // loop and reset() both restore these parameters and would otherwise undo a one-off write.
    this.rigBaseline = new Map();
    for (const id of this.expressionParameterIds.values()) for (const parameter of id) {
      if (!this.rigBaseline.has(parameter)) this.rigBaseline.set(parameter, this.get(parameter));
    }
  }
  /** Parameters forced by the operator's "隐藏" choices, as offsets from the rig's own baseline.
   *  The value comes from the policy (or the hidden expression's own parameter value), because a
   *  rig may invert its control: this rig shows its watermark at Param50 = 0 and hides it at 1. */
  hiddenParameters() {
    const result = new Map();
    for (const [presetId, chosen] of this.hiddenValues ?? []) {
      const item = presets.get(presetId);
      const name = item?.expressionName;
      if (!name) continue;
      for (const parameter of this.expressionParameterIds.get(name) ?? []) {
        // An explicit policy value wins; otherwise use the value the expression itself would set,
        // which is exactly what activating that expression does.
        const value = Number.isFinite(chosen) && chosen !== 0 ? chosen : this.expressionParameterValues.get(name)?.get(parameter) ?? 0;
        result.set(parameter, value);
      }
    }
    return result;
  }
  /** Force every hidden expression's parameters on this frame. The render loop and reset() both
   *  restore these parameters, so a one-off write would be undone; re-applying every frame is what
   *  activating the expression would do, which is why this is the mechanism that actually hides it. */
  applyHiddenParameters() {
    if (!this._model) return;
    const forced = this.hiddenParameters();
    this.hiddenOverrides = forced;
    for (const [id, value] of forced) this.set(id, (this.rigBaseline?.get(id) ?? 0) + value);
  }
  /** Report the hidden-parameter decision once per policy change (never per frame). */
  reportHiddenParameters() {
    const forced = this.hiddenOverrides ?? new Map();
    this.report({ type: 'hidden-parameters', expressions: [...(this.hiddenExpressions ?? [])],
      forced: Object.fromEntries(forced),
      actual: Object.fromEntries([...forced.keys()].map(id => [id, this.get(id)])) });
  }
  set(name, value) { const m = this._model; const id = CubismFramework.getIdManager().getId(name); const i = m.getParameterIndex(id); if (i >= 0 && i < m.getParameterCount()) m.setParameterValueByIndex(i, value); }
  get(name) { return this._model.getParameterValueById(CubismFramework.getIdManager().getId(name)); }
  /**
   * Make the rig look at a point, in -1..1 screen-relative units (negative is left/up). Passing
   * `active: false` returns the rig to its idle sway. Nothing else in the renderer needs to know.
   */
  setLookTarget(x, y, active = true) {
    this.lookActive = active === true;
    this.interaction?.setLook?.(x, y, this.lookActive);
  }
  /** Current cursor-follow state, so the UI can restore its button after a reload. */
  lookTarget() { return { active: this.lookActive === true, ...(this.interaction?.look ?? { x: 0, y: 0 }) }; }
  setAutomaticPolicy(policy) {
    // The host sends this sentinel at a backend-generation boundary. Other
    // foreign model IDs must not silently reset the monotonic revision guard.
    if (policy?.modelId === 'disconnected') this.policyRevision = -1;
    if (policy?.modelId !== presetCatalog.modelId) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    if (!Number.isSafeInteger(policy.revision) || policy.revision < 0 || policy.revision < this.policyRevision) return false;
    // An expression the operator assigned to an emotion is eligible even when the catalog does not
    // mark it automatic, so eligibility here is "automatic or has a real expression".
    const eligible = id => { const item = presets.get(id); return item?.availability === 'automatic' || !!item?.expressionName; };
    if (!Array.isArray(policy.enabledIds) || policy.enabledIds.some(id => !eligible(id))) { this.policyValid = false; this.automaticIds.clear(); this.interaction.release(); this.clearAutomatic(); return false; }
    const next = new Set(policy.enabledIds);
    const nextFaces = resolveFaces(policy);
    // "隐藏" choices translate into parameter overrides, so they belong in the change detection too.
    const rawHidden = Array.isArray(policy.hiddenIds) ? policy.hiddenIds : [];
    const rawValues = policy.hiddenValues && typeof policy.hiddenValues === 'object' ? policy.hiddenValues : {};
    const nextHiddenValues = new Map(rawHidden.map(id => [id, Number.isFinite(rawValues[id]) ? rawValues[id] : 0]));
    const hiddenChanged = nextHiddenValues.size !== (this.hiddenValues?.size ?? 0)
      || [...nextHiddenValues].some(([id, value]) => this.hiddenValues?.get(id) !== value);
    const facesChanged = nextFaces.size !== this.faces.size || [...nextFaces].some(([k, v]) => this.faces.get(k) !== v);
    if (this.policyValid && policy.revision === this.policyRevision && !facesChanged && !hiddenChanged) return next.size === this.automaticIds.size && [...next].every(id => this.automaticIds.has(id));
    this.faces = nextFaces;
    this.hiddenValues = nextHiddenValues;
    this.hiddenExpressions = new Set([...nextHiddenValues.keys()].map(id => presets.get(id)?.expressionName).filter(Boolean));
    // Register the parameters of every expression an emotion can reach. Rig expressions are
    // shipped as 'manual', so they are not in expressionParameters by default; without this the
    // per-frame reset wipes the expression immediately and the emotion appears to do nothing.
    for (const item of this.faces.values()) {
      if (item.expressionName) for (const id of this.expressionParameterIds.get(item.expressionName) ?? []) this.expressionParameters.add(id);
    }
    this.policyValid = true; this.policyRevision = policy.revision; this.automaticIds = next;
    this.applyHiddenParameters();
    this.reportHiddenParameters();
    // Report the resolved mapping so an operator can see which expression each emotion selects.
    this.report({ type: 'emotion-map', revision: policy.revision,
      map: Object.fromEntries([...nextFaces].filter(([, item]) => next.has(item.id)).map(([emotion, item]) => [emotion, item.expressionName])) });
    if (!['proc-head', 'proc-body', 'proc-blink'].some(id => next.has(id))) this.interaction.release();
    if (!this.previewMode) {
      // Release an expression that is no longer reachable: either its preset left the enabled set
      // or the operator re-assigned that emotion to a different expression.
      if (this.faceKey && ![...nextFaces.values()].some(item => item.expressionName === this.faceKey && next.has(item.id))) {
        this._expressionManager.stopAllMotions(); this.faceKey = ''; this.expressionValues.clear();
      }
    }
    return true;
  }
  clearAutomatic() {
    if (!this.previewMode) this._motionManager.stopAllMotions();
    this._expressionManager.stopAllMotions(); this.gestureManager.stopAllMotions();
    this.faceKey = ''; this.gestureKey = ''; this.expressionValues.clear();
  }
  captureAppearance() {
    if (!this.defaults) return;
    for (const id of this.appearanceParameters) this.defaults[this.parameterIndices.get(id)] = this.get(id);
  }
  beginAttention() {
    if (this.ready && !this.previewMode && this.policyValid && ['proc-head', 'proc-body', 'proc-blink'].some(id => this.automaticIds.has(id))) this.interaction.start(performance.now());
  }
  reset({ preserveAttention = false } = {}) {
    if (!preserveAttention) this.interaction.release();
    this.clearAutomatic();
    if (this.previewMode) { this.stopPreview(); return; }
    // Release transient controls only; clothing/accessory state is not a turn.
    if (this._model && this.defaults) for (const id of this.runtimeParameters) if (!interactionParameters.includes(id)) this.set(id, this.defaults[this.parameterIndices.get(id)]);
    // A reset restores defaults, so re-apply the operator's hidden-parameter overrides afterwards.
    for (const [id, value] of this.hiddenOverrides ?? []) this.set(id, value);
  }
  enterPreview() {
    if (this.previewMode) return;
    this.clearAutomatic(); this.previewMode = true;
    this.previewBaseline = Array.from(this._model.getModel().parameters.values);
    for (const id of this.previewParameters) this.previewValues.set(id, this.get(id));
  }
  selectPreset(id) {
    const item = presets.get(id);
    if (!this._model || !item?.previewable || item.availability === 'unavailable') throw new Error('这个预设暂时不能预览');
    this.enterPreview(); this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions(); this.previewSelection = item;
    if (item.expressionName) this.previewManager.startMotion(this.expressions.get(item.expressionName), false);
    return true;
  }
  stopPreview() {
    if (!this._model) return;
    this.enterPreview(); this.previewSelection = null; this.previewManager.stopAllMotions(); this._motionManager.stopAllMotions();
  }
  restorePreview() { this.stopPreview(); }
  blendParameters(parameters, values, delta) {
    const blend = 1 - Math.exp(-Math.max(0, delta) / .12);
    for (const id of parameters) {
      if (id === 'ParamMouthOpenY') continue;
      const target = this.get(id), previous = values.get(id) ?? target;
      const value = Math.abs(target - previous) < .0001 ? target : previous + (target - previous) * blend;
      values.set(id, value); this.set(id, value);
    }
  }
  updateView(view, interactionState = view.state, workFocus = false) {
    if (!this.ready) return;
    const now = performance.now(), delta = Math.min((now - this.last) / 1000, .1); this.last = now; this.elapsed += delta;
    if (!this.previewMode) this.captureAppearance();
    this._model.getModel().parameters.values.set(this.previewMode ? this.previewBaseline : this.defaults);
    const enabled = id => this.previewMode ? this.previewSelection?.id === id : this.automaticIds.has(id);
    const workActive=enabled('proc-work-focus') && (this.previewMode || workFocus && ['idle','error'].includes(view.state));
    if (enabled('motion-idle-0')) {
      if (this._motionManager.isFinished()) this._motionManager.startMotionPriority(this.idle, false, 1);
      this._motionManager.updateMotion(this._model, delta);
    } else this._motionManager.stopAllMotions();
    // Always on: the rig has no EyeBlink group to be enabled by a policy preset.
    this.blink.updateParameters(this._model, delta);
    const rawExpression = workActive ? {emotion:'neutral',intensity:0,delivery:'',gesture:null} : view.invitation && view.state === 'idle' ? { emotion: 'neutral', intensity: 0, delivery: '', gesture: view.invitation.gesture } : view.expression;
    const expression = normalizePresentationIntent(rawExpression);
    // A reply may name a primary preset. Report which one was used so a support session can tell
    // why an emotion did or did not reach the rig.
    const faceItem = this.faces.get(expression.emotion), gestureItem = gestures.get(expression.gesture);
    let face = '', gesture = '';
    if (!this.previewMode) {
      // A reply may name a primary preset. When that id is usable it wins; when it is absent,
      // unknown or not enabled it must NOT suppress the expression, because the operator's emotion
      // mapping is the thing they configured. Falling back keeps a "\"presetId\": null" from the
      // dialogue model — or a stale id after a model swap — from silently disabling every emotion.
      const named = Object.hasOwn(expression, 'presetId') ? presets.get(expression.presetId) : undefined;
      const namedUsable = named?.availability === 'automatic' && named.category !== 'appearance' && enabled(named.id);
      if (namedUsable) {
        if (named.category === 'expression') face = named.expressionName;
        if (named.category === 'pose') gesture = named.expressionName;
      } else {
        face = faceItem && enabled(faceItem.id) ? faceItem.expressionName : '';
        gesture = gestureItem && enabled(gestureItem.id) ? gestureItem.expressionName : '';
      }
    }
    if (face !== this.faceKey) { this._expressionManager.stopAllMotions(); if (face) this._expressionManager.startMotion(this.expressions.get(face), false); this.faceKey = face; }
    if (gesture !== this.gestureKey) { this.gestureManager.stopAllMotions(); if (gesture) this.gestureManager.startMotion(this.expressions.get(gesture), false); this.gestureKey = gesture; }
    // Report why an expression was or was not applied. The emotion resolving is not enough: the
    // expression only reaches the model if it is also enabled and its parameters are registered.
    if (expression.emotion !== this.lastReportedEmotion || face !== this.lastReportedFace) {
      this.lastReportedEmotion = expression.emotion;
      this.lastReportedFace = face;
      const ids = face ? (this.expressionParameterIds.get(face) ?? []) : [];
      // Labels and parameter names only — never any message text.
      this.report({ type: 'expression-emotion', raw: String(rawExpression?.emotion ?? ''), resolved: expression.emotion,
        intensity: Number.isFinite(rawExpression?.intensity) ? rawExpression.intensity : null,
        namedPreset: Object.hasOwn(expression, 'presetId') ? String(expression.presetId) : null,
        faceItemId: faceItem?.id ?? null, enabled: faceItem ? enabled(faceItem.id) : null,
        computedFace: face, faceKey: this.faceKey, registered: ids.filter(id => this.expressionParameters.has(id)).length });
    }
    this._expressionManager.updateMotion(this._model, delta); this.gestureManager.updateMotion(this._model, delta);
    if (this.previewMode) this.previewManager.updateMotion(this._model, delta);
    // The SDK managers reset on intent changes. Carry only supported expression
    // parameters across frames, so changing a face/pose does not pop to defaults.
    if (!this.previewMode) this.blendParameters(this.expressionParameters, this.expressionValues, delta);
    // Held last: the reset above and the expression blend both touch these parameters, so a hidden
    // expression has to win on every frame to actually stay hidden.
    if (!this.previewMode && this.hiddenOverrides?.size) this.applyHiddenParameters();
    const active = !this.previewMode && view.state === 'speaking';
    // Cursor following is the operator's explicit choice, so it must not depend on the optional
    // proc-head/proc-body catalog rows: those id's exist only for rigs that ship them, and an
    // imported model has neither. Look mode therefore enables the head and body channels itself.
    const looking = !this.previewMode && this.lookActive === true;
    const movement = this.interaction.sample({ now, delta, elapsed: this.elapsed, state: this.previewMode ? 'idle' : interactionState,
      head: looking || enabled('proc-head')||workActive, body: looking || enabled('proc-body')||workActive, blink: enabled('proc-blink')||workActive, work:workActive, reducedMotion:globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches===true });
    if (looking || enabled('proc-head') || workActive) {
      // Rigs differ: the historical asset uses ParamAngleX2/X3/X4 for head aim while
      // standard exports use ParamAngleX/Y/Z. Write the ones this rig actually declares,
      // otherwise the head never moves and every physics chain stays at rest.
      const has = id => this.parameterIndices.has(id);
      if (has('ParamAngleX2')) { this.set('ParamAngleX2', movement.yaw); this.set('ParamAngleX3', movement.pitch); this.set('ParamAngleX4', movement.roll); }
      if (has('ParamAngleX') || has('ParamAngleY') || has('ParamAngleZ')) {
        const L = MOTION_TUNING.headAngleLimit, S = MOTION_TUNING.headAngleScale;
        this.set('ParamAngleX', Math.max(-L, Math.min(L, this.get('ParamAngleX') + movement.yaw * S)));
        this.set('ParamAngleY', Math.max(-L, Math.min(L, this.get('ParamAngleY') + movement.pitch * S)));
        this.set('ParamAngleZ', Math.max(-L, Math.min(L, this.get('ParamAngleZ') + movement.roll * S)));
      }
      this.set('ParamEyeBallX', movement.gazeX); this.set('ParamEyeBallY', movement.gazeY);
    }
    if (workActive || enabled('proc-blink') && !this.previewMode) {
      this.set('ParamEyeLOpen', Math.min(this.get('ParamEyeLOpen'), 1 - movement.blink * .95));
      this.set('ParamEyeROpen', Math.min(this.get('ParamEyeROpen'), 1 - movement.blink * .95));
    }
    // Idle breathing must be driven explicitly: a rig with no bundled motion file has
    // nothing else animating ParamBreath, and this model's physics chains read it.
    // It is written BEFORE evaluate() so the pendulum physics sees the fresh value.
    if (this.parameterIndices.has('ParamBreath')) this.breath.updateParameters(this._model, delta);
    if (this._physics) this._physics.evaluate(this._model, delta);
    // Deliberate body movement layers after this model's physics; mouth remains last.
    if (looking || enabled('proc-body') || workActive) {
      this.set('ParamBodyAngleX', this.get('ParamBodyAngleX') + movement.body * MOTION_TUNING.bodyAngleScale);
      // Rigs that declare the full body set lean further while looking; the physics chains then carry
      // the tilt into clothing and hair, which is the effect Cubism's cursor preview shows.
      if (this.parameterIndices.has('ParamBodyAngleY')) this.set('ParamBodyAngleY', movement.bodyYaw ?? movement.body);
      if (this.parameterIndices.has('ParamBodyAngleZ')) this.set('ParamBodyAngleZ', movement.bodyRoll ?? 0);
    }
    if (this.previewMode) this.blendParameters(this.previewParameters, this.previewValues, delta);
    // This asset's MouthForm2 is a smile shape; only MouthOpenY receives output amplitude.
    this.set('ParamMouthForm2', face === '星星眼' ? .7 : face === '脸红' ? .25 : 0);
    this.set('ParamMouthOpenY', active ? Math.min(1, Math.sqrt(view.mouth) * 1.9) : 0);
    this.set('fase80', 1);
    this._model.update();
    this.draw();
  }
  setFraming(mode) {
    if (!['full', 'half'].includes(mode) || this.framing === mode && this.projection) return;
    if (mode === 'full') this.feather?.releaseTexture();
    this.framing = mode; this.syncViewport(true);
  }
  /** Wheel zoom, clamped so a stray delta cannot collapse or blow up the projection. */
  setModelZoom(value) {
    if (!Number.isFinite(value)) return this.modelZoom;
    const next = Math.min(8, Math.max(0.2, value));
    if (next === this.modelZoom) return this.modelZoom;
    this.modelZoom = next; this.syncViewport(true); return this.modelZoom;
  }
  /** Movement mode. Values are fractions of canvas width; returns the applied offset. */
  setModelOffset(x, y) {
    if (Number.isFinite(x)) this.modelOffsetX = Math.max(-3, Math.min(3, x));
    if (Number.isFinite(y)) this.modelOffsetY = Math.max(-3, Math.min(3, y));
    this.syncViewport(true);
    return { x: this.modelOffsetX, y: this.modelOffsetY };
  }
  modelOffset() { return { x: this.modelOffsetX, y: this.modelOffsetY }; }
  /** Backing-store multiplier for the CSS-scaled movement-mode zoom. */
  setResolutionScale(value) {
    const next = Number.isFinite(value) && value > 0 ? Math.min(3, Math.max(0.5, value)) : 1;
    if (next === this.resolutionScale) return;
    this.resolutionScale = next; this.syncViewport(true);
  }
  syncViewport(force = false) {
    if (!this.canvas) return;
    // A bounded 2x canvas also antialiases the large supplied textures on 1x screens.
    // No mip chain is allocated for the 8192/4096 texture sources.
    const dpr = Math.max(2, globalThis.devicePixelRatio || 1);
    const limit = this.gl?.getParameter(this.gl.MAX_RENDERBUFFER_SIZE) || 4096;
    // resolutionScale raises the backing store so a CSS-scaled element stays sharp.
    const scale = Math.min(dpr * this.resolutionScale, limit / Math.max(1, this.canvas.clientWidth, this.canvas.clientHeight));
    const width = Math.max(1, Math.round(this.canvas.clientWidth * scale)), height = Math.max(1, Math.round(this.canvas.clientHeight * scale));
    if (!force && this.canvas.width === width && this.canvas.height === height) return;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width; this.canvas.height = height;
      this.setRenderTargetSize(width, height);
    }
    if (!this._modelMatrix) return;
    const zoom = (this.framing === 'half' ? 3.2 : 1) * this.modelZoom;
    this.projection = new CubismMatrix44();
    this.projection.scale(height / width * zoom, zoom); this.projection.multiplyByMatrix(this._modelMatrix);
    if (this.framing === 'half') this.projection.translateY(-1.35);
    // Movement mode: shift the model inside its canvas, leaving scale untouched.
    // The offset is stored in screen orientation (positive = right/down). Only Y is negated:
    // the projection is built from the canvas aspect and read in clip space, so the model's
    // +Y runs opposite to the screen's, while +X already matches drag-right. (The half-body
    // preset above is the same Y inversion, applied as translateY(-1.35).)
    // translateRelative accumulates; translateX/translateY would assign and clobber that preset.
    if (this.modelOffsetX || this.modelOffsetY) this.projection.translateRelative(this.modelOffsetX * 2, -this.modelOffsetY * 2);
  }
  draw() {
    this.syncViewport();
    const gl = this.gl; gl.viewport(0, 0, this.canvas.width, this.canvas.height); gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    this.getRenderer().setMvpMatrix(this.projection); this.getRenderer().setRenderState(null, [0, 0, this.canvas.width, this.canvas.height]); this.getRenderer().drawModel();
    if (this.framing === 'half') {
      this.feather ??= new ModelFeather(gl);
      if (!this.feather.apply(this.canvas) && !this.featherWarning) {
        this.featherWarning = true; this.report({ type: 'model-feather-unavailable', reason: this.feather.status });
      }
    }
  }
  // Live view of the idle-animation knobs, and a setter so they can be tuned from the
  // console without a rebuild (e.g. WhaleDesktop.setMotionTuning({ breathPeak: 0.8 })).
  motionTuning() { return { ...MOTION_TUNING }; }
  setMotionTuning(patch = {}) {
    for (const key of Object.keys(MOTION_TUNING)) {
      const v = patch[key];
      if (typeof v === 'number' && Number.isFinite(v)) MOTION_TUNING[key] = v;
    }
    if (this.parameterIndices?.has('ParamBreath'))
      this.breath.setParameters([{ parameterId: CubismFramework.getIdManager().getId('ParamBreath'), offset: MOTION_TUNING.breathOffset, peak: MOTION_TUNING.breathPeak, cycle: MOTION_TUNING.breathCycle, weight: 1 }]);
    return this.motionTuning();
  }
  // physicsDiagnostics exposes the parameter ranges and the head/physics read-outs the
  // idle animation depends on: a rig whose ranges are inert makes the model look frozen.
  physicsDiagnostics() {
    const m = this._model?.getModel();
    if (!m) return null;
    const read = id => { const i = this.parameterIndices.get(id); return i === undefined ? null : { value: m.parameters.values[i], min: m.parameters.minimumValues[i], max: m.parameters.maximumValues[i], def: m.parameters.defaultValues[i] }; };
    const ids = ['ParamBreath', 'ParamAngleX', 'ParamAngleY', 'ParamAngleZ', 'ParamBodyAngleX', 'ParamBodyAngleY', 'Param44', 'Param79', 'Param117', 'Param26', 'Param47'];
    return { hasPhysics: !!this._physics, physicsRig: this._physics?._physicsRig?.subRigCount ?? null, parameters: Object.fromEntries(ids.map(id => [id, read(id)])) };
  }
  snapshot() { return { mouth: this.get('ParamMouthOpenY'), body: this.get('ParamBodyAngleX'), face: this.faceKey, gesture: this.gestureKey, breath: this.get('ParamBreath') }; }
  dispose() {
    if (this.disposed) return;
    this.disposed = true; this.ready = false; this.feather?.dispose();
    this.gestureManager.stopAllMotions(); this.gestureManager.release(); this.previewManager.stopAllMotions(); this.previewManager.release();
    for (const tex of this.textures) this.gl?.deleteTexture(tex);
    this.textures = []; this.expressions.clear(); this.previewValues.clear(); this.release();
    // The SDK renderer releases buffers/masks, but shader programs belong to its
    // context manager. Release that manager after our last canvas is disposed.
    if (webglOwners.delete(this) && webglOwners.size === 0) CubismShaderManager_WebGL.deleteInstance();
  }
}
