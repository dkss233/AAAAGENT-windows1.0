// Browser half: open the Session the desktop pet asked for.
//
// The pet hands the operator a link of the form #aaaagent-session=1&sid=<sessionId>&cwd=<cwd>. The
// upstream DSH client already exposes the two things needed to honour it - ctx.sessions (catalog) and
// ctx.uiWorkspace.openSession() (select the Session and show its conversation) - so this plugin is
// only the glue. It replaces a byte-patched copy of DSH's own client bundle: same feature, public API.
//
// This file is authored directly in the module-loader format the DSH web boot uses, which is why it is
// not bundled: window.__ModuleLoader__.load({ id, factory }) with exports.apply/inject/name.
window.__ModuleLoader__.load({
  id: '@aaaagent/dsh-session-entry',
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

    const name = 'aaaagent-session-entry';
    const inject = ['uiWorkspace', 'sessions'];
    const sessionId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

    /** Read one pet deep link. Anything unrecognised is ignored rather than guessed at. */
    const readEntry = () => {
      const hash = String(globalThis.location && globalThis.location.hash ? globalThis.location.hash : '');
      if (!hash.startsWith('#')) return null;
      let params;
      try { params = new URLSearchParams(hash.slice(1)); } catch { return null; }
      if (params.get('aaaagent-session') !== '1') return null;
      const sid = params.get('sid') || '';
      if (!sessionId.test(sid)) return null;
      return sid;
    };

    function apply(ctx) {
      let opened = null;
      let running = false;
      const consume = () => {
        try {
          const url = new URL(globalThis.location.href);
          url.hash = '';
          globalThis.history && globalThis.history.replaceState ? globalThis.history.replaceState(null, '', url.href) : undefined;
        } catch { /* the entry stays in the hash; it simply reopens on the next load */ }
      };
      const open = async () => {
        if (running) return;
        const sid = readEntry();
        if (!sid || sid === opened) return;
        running = true;
        try {
          // The catalog must know the Session before navigation can select it, but a stale catalog is
          // no reason to refuse: openSession works for any Session the client already lists.
          try { if (ctx.sessions && typeof ctx.sessions.refresh === 'function') await ctx.sessions.refresh(); } catch { /* stale catalog is acceptable */ }
          ctx.uiWorkspace.openSession(sid);
          opened = sid;
          consume();
        } catch { /* never break the console because a deep link went stale */ }
        finally { running = false; }
      };
      const start = () => {
        const timer = globalThis.setTimeout(() => { void open(); }, 0);
        const onChange = () => { void open(); };
        if (globalThis.addEventListener) globalThis.addEventListener('hashchange', onChange);
        const dispose = () => {
          globalThis.clearTimeout(timer);
          if (globalThis.removeEventListener) globalThis.removeEventListener('hashchange', onChange);
        };
        return dispose;
      };
      if (typeof ctx.effect === 'function') ctx.effect(start);
      else start();
    }

    exports.name = name;
    exports.inject = inject;
    exports.apply = apply;
    return module.exports;
  }
});
