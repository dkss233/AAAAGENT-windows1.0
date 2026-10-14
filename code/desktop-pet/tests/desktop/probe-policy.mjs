/** Engineering-only trigger policy. It cannot open a device or invoke a model. */
export class ProbePolicy {
  #used = false;
  request(source, hasAudio) {
    if (source !== 'explicit_play') return {play:false,reason:'ordinary-input'};
    if (!hasAudio) return {play:false,reason:'missing-audio'};
    if (this.#used) return {play:false,reason:'already-used'};
    this.#used=true;return {play:true};
  }
}
