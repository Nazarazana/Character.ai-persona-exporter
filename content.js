// Isolated-world bridge: receives data from injected.js, parses personas, stores them.
(function () {
  'use strict';
  const KEY = 'personas';
  const RAW_KEY = 'lastRaw';

  // ---- parsing ----
  // Walk any JSON and collect objects that look like personas.
  function extractPersonas(data) {
    const out = [];
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 7) return;
      if (Array.isArray(o)) { o.forEach((x) => walk(x, depth + 1)); return; }
      const id = o.external_id || o.id;
      const hasName = o.name || o.participant__name || o.title;
      const looksLikePersona = id && hasName && (o.definition !== undefined || o.participant__name !== undefined);
      if (looksLikePersona) { out.push(o); return; }
      Object.values(o).forEach((v) => walk(v, depth + 1));
    })(data, 0);
    return out;
  }

  function normalize(p) {
    const id = String(p.external_id || p.id);
    const name = p.name || p.participant__name || p.title || 'Unnamed persona';
    const title = p.title && p.title !== name ? p.title : '';
    return {
      id,
      name,
      title,
      definition: p.definition || p.description || '',
      avatar_file_name: p.avatar_file_name || p.avatar_rel_path || p.avatar || '',
      raw: p,
      capturedAt: new Date().toISOString()
    };
  }

  // ---- storage (serialized to avoid races) ----
  let chain = Promise.resolve();
  function saveFromResponse(url, data) {
    chain = chain.then(async () => {
      try {
        const found = extractPersonas(data);
        await chrome.storage.local.set({ [RAW_KEY]: { url, capturedAt: new Date().toISOString(), data } });
        if (!found.length) return 0;
        const stored = (await chrome.storage.local.get([KEY]))[KEY] || {};
        found.forEach((p) => {
          const n = normalize(p);
          stored[n.id] = { ...(stored[n.id] || {}), ...n };
        });
        await chrome.storage.local.set({ [KEY]: stored });
        return found.length;
      } catch (e) {
        return 0; // extension context invalidated, etc.
      }
    });
    return chain;
  }

  document.addEventListener('__CAI_PX_CAPTURE__', (ev) => {
    try {
      const { url, data } = JSON.parse(ev.detail);
      saveFromResponse(url, data);
    } catch (e) { /* ignore */ }
  });

  // ---- popup -> page: actively fetch personas ----
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.action === 'fetchPersonas') {
      let done = false;
      const finish = (payload) => { if (!done) { done = true; sendResponse(payload); } };

      const timer = setTimeout(() => finish({ success: false, error: 'Timed out waiting for the page.' }), 20000);

      document.addEventListener('__CAI_PX_FETCH_RESULT__', async function handler(ev) {
        document.removeEventListener('__CAI_PX_FETCH_RESULT__', handler);
        clearTimeout(timer);
        try {
          const { results, errors, hadAuth } = JSON.parse(ev.detail);
          let count = 0;
          for (const r of results) count += await saveFromResponse(r.url, r.data);
          finish({ success: true, count, errors, hadAuth });
        } catch (e) {
          finish({ success: false, error: e.message });
        }
      });

      document.dispatchEvent(new CustomEvent('__CAI_PX_FETCH__'));
      return true; // async
    }
    return false;
  });
})();
