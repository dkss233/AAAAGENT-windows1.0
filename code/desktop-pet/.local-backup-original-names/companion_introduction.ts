import type { CompanionIntroduction } from '../contracts/character.js';

/** Presentation only. Never pass this text to append, summarization, or memory maintenance. */
export const COMPANION_INTRODUCTION: Readonly<CompanionIntroduction> = Object.freeze({
  id: 'companion-first-meeting',
  text: '你好啊，今天准备做些什么呢',
});
