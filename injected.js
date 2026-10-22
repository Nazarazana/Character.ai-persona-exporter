// Runs in the page's own JS context (world: MAIN) so it can wrap fetch / XHR
// before Character.ai's code uses them.
(function () {
  'use strict';
  if (window.__CAI_PX_INJECTED__) return;
  window.__CAI_PX_INJECTED__ = true;

  let authHeader = null; // last Authorization header seen on a character.ai request

  const emit = (name, obj) =>
    document.dispatchEvent(new CustomEvent(name, { detail: JSON.stringify(obj) }));

  const isPersonaUrl = (u) => /persona/i.test(u || '');
  const isCaiUrl = (u) => /character\.ai/i.test(u || '');

  function rememberAuth(url, name, value) {
    if (/^authorization$/i.test(name) && isCaiUrl(url) && value) authHeader = value;
  }

  function sniffHeaders(url, headers) {
    if (!headers) return;
    try {
      if (headers instanceof Headers) {
        headers.forEach((v, k) => rememberAuth(url, k, v));
      } else if (Array.isArray(headers)) {
        headers.forEach(([k, v]) => rememberAuth(url, k, v));
      } else {
        Object.keys(headers).forEach((k) => rememberAuth(url, k, headers[k]));
      }
    } catch (e) { /* ignore */ }
  }

  // ---------- XHR ----------
  const xOpen = XMLHttpRequest.prototype.open;
  const xSend = XMLHttpRequest.prototype.send;
  const xSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__caiPxUrl = String(url || '');
    return xOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    rememberAuth(this.__caiPxUrl, name, value);
    return xSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const url = this.__caiPxUrl || '';
    if (isPersonaUrl(url)) {
      this.addEventListener('loadend', () => {
        try {
          if (this.status < 200 || this.status >= 300) return;
          if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return;
          const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText);
          emit('__CAI_PX_CAPTURE__', { url, data });
        } catch (e) { /* not JSON */ }
      });
    }
    return xSend.apply(this, args);
  };

  // ---------- fetch ----------
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    let url = '';
    try {
      const a0 = args[0];
      url = typeof a0 === 'string' ? a0 : (a0 && a0.url) || String(a0);
      sniffHeaders(url, args[1] && args[1].headers);
      if (a0 && typeof a0 === 'object' && a0.headers) sniffHeaders(url, a0.headers);
    } catch (e) { /* ignore */ }

    const response = await origFetch.apply(this, args);

    if (isPersonaUrl(url) && response.ok) {
      try {
        response.clone().json().then((data) => emit('__CAI_PX_CAPTURE__', { url, data })).catch(() => {});
      } catch (e) { /* ignore */ }
    }
    return response;
  };

  // ---------- Active fetch (triggered by the popup via content.js) ----------
  // These endpoints are best guesses; passive capture above is the reliable path.
  const ENDPOINTS = [
    'https://neo.character.ai/personas/?force_refresh=1',
    'https://plus.character.ai/chat/personas/?force_refresh=1',
    'https://plus.character.ai/chat/personas/'
  ];

  document.addEventListener('__CAI_PX_FETCH__', async () => {
    const results = [];
    const errors = [];
    for (const url of ENDPOINTS) {
      try {
        const headers = { Accept: 'application/json' };
        if (authHeader) headers.Authorization = authHeader;
        const res = await origFetch(url, { method: 'GET', credentials: 'include', headers });
        if (!res.ok) { errors.push(url + ' -> HTTP ' + res.status); continue; }
        const data = await res.json();
        results.push({ url, data });
      } catch (e) {
        errors.push(url + ' -> ' + (e && e.message ? e.message : e));
      }
    }
    emit('__CAI_PX_FETCH_RESULT__', { results, errors, hadAuth: !!authHeader });
  });
})();
