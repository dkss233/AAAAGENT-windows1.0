export interface PresentationPreset {
  readonly id: string; readonly label: string;
  readonly category: 'expression' | 'pose' | 'appearance' | 'idle';
  readonly source: 'model-expression' | 'model-motion' | 'procedural';
  readonly availability: 'automatic' | 'manual' | 'unavailable';
  readonly defaultEnabled: boolean; readonly previewable: boolean;
  readonly reason?: string; readonly expressionName?: string;
  /** Parameters this expression drives. Shown so an operator can see what a "隐藏" choice sets to 0. */
  readonly parameters?: readonly string[];
  readonly motionGroup?: string; readonly motionIndex?: number; readonly procedure?: string;
  readonly emotions?: readonly string[]; readonly gestures?: readonly string[];
}
export interface PresentationCatalog {
  readonly schemaVersion: 1; readonly modelId: string; readonly modelFingerprint: string;
  readonly items: readonly PresentationPreset[];
}
export interface PresentationPolicy {
  readonly modelId: string; readonly revision: number; readonly enabledIds: readonly string[];
  /** Operator-chosen emotion → preset id. This is what lets the pet switch to an expression on its
   *  own; an empty map keeps only the catalog's shipped defaults. Editable at runtime. */
  readonly emotions: Readonly<Record<string, string>>;
  /** Presets the operator marked "隐藏". They stay in the catalog but their parameters are forced
   *  to the value in `hiddenValues`, which is what actually removes them from the rendered rig. */
  readonly hiddenIds: readonly string[];
  /** preset id → the value to force that preset's parameters to when hidden. Defaults to 0, but a
   *  rig may invert its control — an author-mark expression can be shown at one value and hidden at
   *  another — so the stored value is whatever the operator measured on their own model. */
  readonly hiddenValues: Readonly<Record<string, number>>;
}
export interface PresentationControls {
  readonly catalog: PresentationCatalog;
  snapshot(): PresentationPolicy;
  save(modelId: string, expectedRevision: number, enabledIds: unknown, emotions?: unknown, hiddenIds?: unknown, hiddenValues?: unknown): Promise<PresentationPolicy>;
  allowedIntent(): { emotions: readonly string[]; gestures: readonly string[]; presets: readonly { id: string; label: string }[] };
}
