export interface VoiceInputTarget {
  readonly environmentId: string;
  readonly threadId: string;
  readonly inputId: string;
  readonly epoch: number;
}

// Preview input only. This bridge never requests a microphone or sends a task.
export class PreviewVoiceBridge {
  private active: VoiceInputTarget | null = null;
  private readonly consumed = new Set<string>();

  begin(target: VoiceInputTarget): void {
    this.active = Object.freeze({ ...target });
  }

  cancel(): void { this.active = null; }

  receive(target: VoiceInputTarget, text: string, fillOriginalDraft: (rawText: string) => void): boolean {
    const active = this.active;
    if (!active || !text.trim() || active.environmentId !== target.environmentId ||
      active.threadId !== target.threadId || active.inputId !== target.inputId || active.epoch !== target.epoch) return false;
    const key = JSON.stringify([target.environmentId, target.threadId, target.inputId, target.epoch]);
    if (this.consumed.has(key)) return false;
    this.consumed.add(key);
    this.active = null;
    fillOriginalDraft(text);
    return true;
  }
}
