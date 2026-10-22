const KEY = 'personas';
const $ = (id) => document.getElementById(id);

let personas = {};
let selected = new Set();
let mode = 'png';
let format = 'cai';
let query = '';

// ---------------------------------------------------------------- helpers
const escapeHtml = (s) => {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
};
const sanitizeFilename = (n) => String(n || 'persona').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 100) || 'persona';

let statusTimer;
function status(msg, type = 'ok', sticky = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = type;
  el.style.display = 'block';
  clearTimeout(statusTimer);
  if (!sticky) statusTimer = setTimeout(() => (el.style.display = 'none'), 4000);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

// ---------------------------------------------------------------- avatars
function avatarCandidates(p) {
  const f = p.avatar_file_name;
  if (!f) return [];
  if (/^https?:\/\//i.test(f)) return [f];
  let path = String(f).replace(/^\/+/, '');
  path = path.replace(/^static\/avatars\//, '');
  const variants = path.startsWith('uploaded/') ? [path] : ['uploaded/' + path, path];
  const urls = [];
  for (const size of [400, 200]) {
    for (const v of variants) urls.push(`https://characterai.io/i/${size}/static/avatars/${v}`);
  }
  return urls;
}

async function fetchAvatarBlob(p) {
  for (const url of avatarCandidates(p)) {
    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob && blob.size > 0) return blob;
    } catch (e) { /* try next */ }
  }
  return null;
}

async function placeholderBlob(name) {
  const c = document.createElement('canvas');
  c.width = c.height = 400;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 400, 400);
  g.addColorStop(0, '#1A0B3B');
  g.addColorStop(1, '#5b3bb5');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 400, 400);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 200px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((name || '?').trim().charAt(0).toUpperCase() || '?', 200, 215);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

// Any image (webp/jpg/avif/gif/png) -> PNG bytes via canvas
async function toPngBytes(blob) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0);
  const png = await new Promise((r) => c.toBlob(r, 'image/png'));
  return new Uint8Array(await png.arrayBuffer());
}

// ---------------------------------------------------------------- PNG metadata
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function makeChunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

// Insert tEXt chunk "chara" (base64 JSON) right before IEND
function embedChara(png, metadata) {
  const dv = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let off = 8, iend = -1;
  while (off + 8 <= png.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(png[off + 4], png[off + 5], png[off + 6], png[off + 7]);
    if (type === 'IEND') { iend = off; break; }
    off += 12 + len;
  }
  if (iend < 0) throw new Error('Invalid PNG (no IEND)');

  const text = 'chara\0' + utf8ToBase64(JSON.stringify(metadata)); // base64 is pure ASCII
  const chunk = makeChunk('tEXt', new TextEncoder().encode(text));

  const out = new Uint8Array(png.length + chunk.length);
  out.set(png.subarray(0, iend), 0);
  out.set(chunk, iend);
  out.set(png.subarray(iend), iend + chunk.length);
  return out;
}

// ---------------------------------------------------------------- formats
function buildMetadata(p) {
  if (format === 'v2') {
    return {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: p.name,
        description: p.definition || '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        creator_notes: 'Exported from a Character.ai persona',
        system_prompt: '',
        post_history_instructions: '',
        alternate_greetings: [],
        tags: ['persona'],
        creator: '',
        character_version: '1.0',
        extensions: {}
      }
    };
  }
  // Same shape the Character.ai Exporter embeds
  const character = { name: p.name };
  if (p.title) character.title = p.title;
  character.description = p.definition || '';
  character.definition = p.definition || '';
  character.has_definition = !!p.definition;
  return { character };
}

function buildTxt(p) {
  const lines = [];
  const add = (label, value) => {
    if (value !== null && value !== undefined && value !== '') {
      lines.push(`--- ${label} ---`, String(value), '');
    }
  };
  add('Name', p.name);
  add('Title', p.title);
  add('Description', p.definition);
  let txt = lines.join('\r\n').replace(/(\r\n)+$/, '');
  return txt + '\r\n';
}

// ---------------------------------------------------------------- export
async function buildPngFile(p, base) {
  let src = await fetchAvatarBlob(p);
  if (!src) src = await placeholderBlob(p.name);
  let png;
  try {
    png = await toPngBytes(src);
  } catch (e) {
    png = await toPngBytes(await placeholderBlob(p.name));
  }
  const withMeta = embedChara(png, buildMetadata(p));
  return { name: base + '.png', blob: new Blob([withMeta], { type: 'image/png' }) };
}

function buildTxtFile(p, base) {
  return { name: base + '.txt', blob: new Blob([buildTxt(p)], { type: 'text/plain;charset=utf-8' }) };
}

// Returns an array of files for one persona, depending on the export mode
async function buildFiles(p) {
  const base = sanitizeFilename(p.name);
  if (mode === 'txt') return [buildTxtFile(p, base)];
  if (mode === 'png') return [await buildPngFile(p, base)];
  return [await buildPngFile(p, base), buildTxtFile(p, base)]; // 'both'
}

async function exportList(list) {
  if (!list.length) { status('No personas to export', 'error'); return; }
  $('exportBtn').disabled = true;
  try {
    // Single persona in a single-file mode: download directly
    if (list.length === 1 && mode !== 'both') {
      status(`Exporting ${list[0].name}…`, 'ok', true);
      const [f] = await buildFiles(list[0]);
      downloadBlob(f.blob, f.name);
      status(`Exported: ${list[0].name}`);
      return;
    }
    const zip = new JSZip();
    const used = new Map();
    let ok = 0, fail = 0;
    for (let i = 0; i < list.length; i++) {
      status(`Processing ${i + 1}/${list.length}: ${list[i].name}…`, 'ok', true);
      try {
        const files = await buildFiles(list[i]);
        if (mode === 'both') {
          // one folder per persona; dedupe folder names
          const folder = sanitizeFilename(list[i].name);
          const n = used.get(folder) || 0;
          used.set(folder, n + 1);
          const folderName = n ? `${folder}_${n + 1}` : folder;
          files.forEach((f) => zip.file(`${folderName}/${f.name}`, f.blob));
        } else {
          for (const f of files) {
            const n = used.get(f.name) || 0;
            used.set(f.name, n + 1);
            const finalName = n ? f.name.replace(/(\.[^.]+)$/, `_${n + 1}$1`) : f.name;
            zip.file(finalName, f.blob);
          }
        }
        ok++;
      } catch (e) {
        console.error(e);
        fail++;
      }
    }
    if (!ok) throw new Error('No personas could be exported');
    status('Creating ZIP…', 'ok', true);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    downloadBlob(blob, `character_ai_personas_${new Date().toISOString().split('T')[0]}.zip`);
    status(fail ? `Exported ${ok} (${fail} failed)` : `Exported ${ok} persona${ok > 1 ? 's' : ''}`);
  } catch (e) {
    status('Error: ' + e.message, 'error');
  } finally {
    $('exportBtn').disabled = false;
  }
}

// ---------------------------------------------------------------- UI
function sortedFiltered() {
  const q = query.trim().toLowerCase();
  return Object.values(personas)
    .filter((p) => !q || (p.name + ' ' + p.title + ' ' + p.definition).toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function render() {
  const all = Object.values(personas);
  const list = sortedFiltered();
  const el = $('list');

  // drop selections that no longer exist
  selected.forEach((id) => { if (!personas[id]) selected.delete(id); });

  $('count').textContent = `${all.length} cached · ${selected.size} selected`;
  $('exportBtn').textContent = selected.size ? `Export ${selected.size} selected` : `Export all (${all.length})`;
  $('exportBtn').disabled = all.length === 0;
  $('exportBtn').className = 'primary' + (mode === 'txt' ? ' txt' : '');
  $('formatRow').style.display = mode === 'txt' ? 'none' : 'flex';

  if (!all.length) {
    el.innerHTML = `<div class="empty">📭<br>No personas cached yet.<br>
      Open <b>character.ai</b> and press <b>Fetch from account</b>,<br>or just open your persona list on the site.</div>`;
    return;
  }
  if (!list.length) { el.innerHTML = '<div class="empty">No matches.</div>'; return; }

  el.innerHTML = list.map((p) => {
    const cands = avatarCandidates(p);
    const img = cands.length
      ? `<img class="avatar" src="${escapeHtml(cands[0])}" data-id="${escapeHtml(p.id)}" data-idx="0">`
      : `<div class="avatar"></div>`;
    const preview = (p.definition || '').replace(/\s+/g, ' ').slice(0, 80);
    return `<div class="item" data-id="${escapeHtml(p.id)}">
      <input type="checkbox" ${selected.has(p.id) ? 'checked' : ''}>
      ${img}
      <div class="info">
        <div class="name">${escapeHtml(p.name)}</div>
        <div class="meta">${escapeHtml(preview) || '(no definition)'}</div>
      </div>
      <button class="small-btn" data-act="export">Export</button>
      <button class="small-btn danger" data-act="delete">✕</button>
    </div>`;
  }).join('');
}

// avatar fallback chain (no inline handlers allowed in MV3)
$('list').addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.dataset.id) return;
  const p = personas[img.dataset.id];
  const cands = p ? avatarCandidates(p) : [];
  const next = Number(img.dataset.idx) + 1;
  if (next < cands.length) { img.dataset.idx = next; img.src = cands[next]; } else { img.style.visibility = 'hidden'; }
}, true);

$('list').addEventListener('click', async (e) => {
  const row = e.target.closest('.item');
  if (!row) return;
  const id = row.dataset.id;
  const act = e.target.closest('button')?.dataset.act;
  if (act === 'export') { e.stopPropagation(); await exportList([personas[id]]); return; }
  if (act === 'delete') {
    e.stopPropagation();
    if (!confirm(`Delete "${personas[id].name}" from the extension's cache? (Your Character.ai account is not affected.)`)) return;
    delete personas[id];
    selected.delete(id);
    await chrome.storage.local.set({ [KEY]: personas });
    render();
    return;
  }
  if (e.target.tagName !== 'INPUT') {
    selected.has(id) ? selected.delete(id) : selected.add(id);
  } else {
    e.target.checked ? selected.add(id) : selected.delete(id);
  }
  render();
});

$('exportBtn').addEventListener('click', () => {
  const list = selected.size ? [...selected].map((id) => personas[id]).filter(Boolean) : Object.values(personas);
  exportList(list);
});
$('selAll').addEventListener('click', () => { sortedFiltered().forEach((p) => selected.add(p.id)); render(); });
$('selNone').addEventListener('click', () => { selected.clear(); render(); });
$('search').addEventListener('input', (e) => { query = e.target.value; render(); });

$('mode').addEventListener('change', (e) => { mode = e.target.value; savePrefs(); render(); });
$('format').addEventListener('change', (e) => { format = e.target.value; savePrefs(); });
const savePrefs = () => chrome.storage.local.set({ prefs: { mode, format } });

$('helpToggle').addEventListener('click', () => {
  const h = $('help');
  h.classList.toggle('show');
  $('helpToggle').textContent = h.classList.contains('show') ? 'Click here to hide instructions' : 'Click here for instructions';
});

$('clearBtn').addEventListener('click', async () => {
  if (!confirm('Delete all cached personas from the extension? (Your Character.ai account is not affected.)')) return;
  personas = {};
  selected.clear();
  await chrome.storage.local.set({ [KEY]: {} });
  render();
  status('Cache cleared');
});

$('fetchBtn').addEventListener('click', async () => {
  const tabs = await chrome.tabs.query({ url: '*://*.character.ai/*' });
  const tab = tabs.find((t) => t.active) || tabs[0];
  if (!tab) { status('Open character.ai in a tab first.', 'error'); return; }
  status('Fetching personas…', 'ok', true);
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'fetchPersonas' });
    if (!res || !res.success) throw new Error(res?.error || 'No response');
    if (res.count > 0) {
      status(`Found ${res.count} persona(s).`);
    } else {
      status(
        'Nothing found automatically. Open your persona list/settings on character.ai once (the extension captures what the page loads), then check again.',
        'error', true
      );
    }
  } catch (e) {
    status('Could not reach the page. Reload the character.ai tab (needed once after installing), then try again.', 'error', true);
  }
});

$('rawBtn').addEventListener('click', async () => {
  const { lastRaw } = await chrome.storage.local.get(['lastRaw']);
  if (!lastRaw) { status('Nothing captured yet.', 'error'); return; }
  downloadBlob(new Blob([JSON.stringify(lastRaw, null, 2)], { type: 'application/json' }), 'last_persona_response.json');
});

// ---------------------------------------------------------------- init
(async function init() {
  const s = await chrome.storage.local.get([KEY, 'prefs']);
  personas = s[KEY] || {};
  mode = s.prefs?.mode || 'png';
  format = s.prefs?.format || 'cai';
  $('mode').value = mode;
  $('format').value = format;
  render();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) {
      personas = changes[KEY].newValue || {};
      render();
    }
  });
})();
