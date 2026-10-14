import type { WorkbenchCapability, WorkbenchTaskRef } from '../contracts/workbench.js';

const version = 'B54-N1/c13f7d9/dsh-0.1.5-rc.2';
const item = (operation: WorkbenchCapability['operation'], status: WorkbenchCapability['status'],
  evidence: WorkbenchCapability['evidence'], detail: string): WorkbenchCapability => ({ operation, status, evidence, version, detail });

/** Static ceiling, not a live Host probe. I may narrow it further after runtime checks. */
export function providerCapabilities(ref: WorkbenchTaskRef): readonly WorkbenchCapability[] {
  if (ref.origin === 'legacy_codex_app') return [
    item('create', 'unsupported', 'source_only', 'Original Codex App task'),
    item('resume', 'unverified', 'source_only', 'Exact original-session continuation has no live evidence; use original Codex App task'),
    item('read', 'unverified', 'source_only', 'Use existing Codex App read path'),
    item('continue', 'unsupported', 'source_only', 'Use original Codex App task until exact resume is verified'),
    item('answer_question', 'unsupported', 'source_only', 'Original task owns the request'),
    item('decide_approval', 'unsupported', 'source_only', 'Original task owns the approval'),
    item('stop_turn', 'unsupported', 'source_only', 'Exact turn stop not verified through this bridge'),
  ];
  if (ref.origin === 'legacy_dsh') return [
    item('create', 'unsupported', 'source_only', 'Original DSH session'),
    item('resume', 'unverified', 'source_only', 'Cold read is available; control remains in original Host'),
    item('read', 'supported', 'isolated_protocol', 'Bounded session/list and session/page fixture verified; live Host pending'),
    item('continue', 'unverified', 'source_only', 'Original session prompt is not yet wired through T3'),
    item('answer_question', 'unsupported', 'source_only', 'No durable native request identity'),
    item('decide_approval', 'unsupported', 'source_only', 'Live Gateway event ID is not a durable approval ID'),
    item('stop_turn', 'unsupported', 'source_only', 'Host cancel lacks expected turn'),
  ];
  return [
    item('create', 'unverified', 'source_only', `${ref.provider} T3 runtime not yet live-tested`),
    item('resume', 'unverified', 'source_only', 'Exact native resume needs live verification'),
    item('read', 'supported', 'isolated_protocol', 'T3 shell identity and terminal projection fixture verified'),
    item('continue', 'unverified', 'source_only', 'Dispatch seam and provider receipt lookup require integration'),
    item('answer_question', 'unsupported', 'source_only', 'Native request identity and lifetime not live-verified'),
    item('decide_approval', 'unsupported', 'source_only', 'Native request identity and lifetime not live-verified'),
    item('stop_turn', 'unsupported', 'source_only', 'Exact turn stop not live-verified'),
  ];
}
