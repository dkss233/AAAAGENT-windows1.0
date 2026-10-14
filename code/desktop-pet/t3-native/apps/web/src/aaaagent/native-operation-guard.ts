const commands = new Set([
  "thread.create", "thread.turn.start", "thread.turn.interrupt",
  "thread.runtime-mode.set", "thread.interaction-mode.set",
  "thread.approval.respond", "thread.user-input.respond", "thread.user-input.dismiss",
  "thread.session.stop", "thread.meta.update",
]);
const writeAction = /^(?:new (?:thread|project|terminal|session|chat)|add (?:project|action)|create |rename|delete|remove |discard|send(?:\b|$)|stop(?:\b|$)|interrupt|approve|deny|allow(?:\b|$)|accept(?:\b|$)|reject|commit|push|pull|merge|apply(?:\b|$)|save(?:\b|$)|run(?:\b|$)|snooze|wake thread|settle(?:\b|$)|un-settle|pin thread|unpin thread|project settings|edit project|clone |import |open terminal|open$|open (?:in|file in|logs folder)|refresh providers)/i;
export const nativeControlSelector = "button,[role=menuitem],[role=menuitemcheckbox],[role=menuitemradio],[role=option]";

function hasPermission(element: HTMLElement): boolean {
  return element instanceof HTMLButtonElement && element.dataset.aaaLocalDraftAction === "true" ||
    element instanceof HTMLButtonElement && element.type === "submit" && element.dataset.aaaSkillTrialSend === "true" ||
    commands.has(element.dataset.aaaNativeCommand ?? "") && element.dataset.aaaNativeAllowed === "true";
}

function isWriteControl(element: HTMLElement): boolean {
  return element.dataset.aaaNativeCommand !== undefined || writeAction.test(
    (element.getAttribute("aria-label") ?? element.getAttribute("title") ?? element.textContent ?? "").trim(),
  );
}

/** The original component supplies its disabled state separately from permission. */
export function lockNativeControl(element: HTMLElement): void {
  if (hasPermission(element)) {
    if (element.dataset.aaaReadonlyAction === "true") {
      delete element.dataset.aaaReadonlyAction;
      element.removeAttribute("aria-disabled");
    }
    if (element.dataset.aaaNativeDisabled !== undefined) {
      const disabled = element.dataset.aaaNativeDisabled !== "false";
      if (element instanceof HTMLButtonElement) element.disabled = disabled;
      if (disabled) element.setAttribute("aria-disabled", "true");
      else element.removeAttribute("aria-disabled");
    }
    return;
  }
  if (!isWriteControl(element)) return;
  element.dataset.aaaReadonlyAction = "true";
  element.setAttribute("aria-disabled", "true");
  if (element instanceof HTMLButtonElement) element.disabled = true;
}

export function preventNativeControlEvent(event: Event): void {
  const element = event.target instanceof Element
    ? event.target.closest<HTMLElement>(nativeControlSelector) : null;
  if (!element) return;
  if (hasPermission(element) && element.dataset.aaaNativeDisabled !== "true") return;
  if (element.dataset.aaaReadonlyAction === "true" || isWriteControl(element)) {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
}
