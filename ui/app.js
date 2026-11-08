'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

const DEFAULTS = {
  theme: 'night', textFont: 'serif', fontSize: 19, codeFontSize: 14, measure: 68, lineHeight: 1.7,
  spellcheck: true, typewriter: false, fade: true, autosave: false, wrapCode: false, lineNumbers: true,
  useSpaces: true, tabSize: 4,
};
const BIG = 400000;   // characters; above this we skip syntax colouring
// Above this, a keystroke shows the text at once without colours and the
// colours follow once typing pauses: colouring the whole document on every
// key (and laying it out again) is what made long documents lag.
const QUICK = 30000;
const COLOUR_AFTER = 250; // ms of no typing

const S = { tabs: [], active: null, settings: { ...DEFAULTS }, nextId: 1, home: '' };
const F = { open: false, cs: false, re: false, matches: [], cur: -1 };

const docsEl = $('#docs'), tabsEl = $('#tabs');

/* ============================== native bridge ============================== */

const native = !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.folio);
const pending = new Map();
let callId = 0;

function call(cmd, args = {}) {
  if (!native) return Promise.resolve(mock(cmd, args));
  return new Promise(resolve => {
    const id = ++callId;
    pending.set(id, resolve);
    window.webkit.messageHandlers.folio.postMessage(JSON.stringify({ id, cmd, args }));
  });
}

window.folio = {
  resolve(id, data) { const r = pending.get(id); pending.delete(id); if (r) r(data); },
  requestClose: () => requestClose(),
  openFiles: files => files.forEach(f => openFileData(f)),
};

// Browser-only fallback so the UI can be previewed without the GTK host.
function mock(cmd, args) {
  const ls = k => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
  switch (cmd) {
    case 'init': return { settings: ls('folio.settings'), files: [], home: '/home/you' };
    case 'saveSettings': try { localStorage.setItem('folio.settings', JSON.stringify(args.settings)); } catch {} return true;
    case 'save': return { mtime: Date.now() };
    case 'saveAs': return { path: '/home/you/' + args.name, name: args.name, mtime: Date.now() };
    case 'stat': return {};
    default: return null;
  }
}

/* ============================== helpers ============================== */

const basename = p => p.split('/').pop();
const prettyDir = p => { const d = p.slice(0, p.lastIndexOf('/')) || '/'; return S.home && d.startsWith(S.home) ? '~' + d.slice(S.home.length) : d; };
const isCode = t => HL.isCode(t.lang);
const isDirty = t => t.ta.value !== t.saved;
const needsSave = t => t.path ? isDirty(t) : t.ta.value.trim() !== '';

function displayName(t) {
  if (t.path) return basename(t.path);
  const first = t.ta.value.split('\n').find(l => l.trim());
  if (!first) return 'Untitled';
  const s = first.replace(/^[#>\-*+\s]+/, '').trim();
  return (s.length > 28 ? s.slice(0, 28).trimEnd() + '…' : s) || 'Untitled';
}

function suggestName(t) {
  if (t.path) return basename(t.path);
  const n = displayName(t).replace(/…$/, '').replace(/[\\/:*?"<>|]+/g, '').trim();
  const ext = t.lang === 'markdown' ? '.md' : '.txt';
  return (n && n !== 'Untitled' ? n : 'Untitled') + ext;
}

function indentUnit() { return S.settings.useSpaces ? ' '.repeat(S.settings.tabSize) : '\t'; }

function reportError(err) {
  console.error(err);
  toast('Something went wrong: ' + (err && err.message || err));
}
window.addEventListener('error', e => reportError(e.error || e.message));
window.addEventListener('unhandledrejection', e => reportError(e.reason));

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

function modal({ title, text = '', html = null, buttons }) {
  return new Promise(resolve => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    const p = $('#modalText');
    if (html) p.innerHTML = html; else p.textContent = text;
    const box = $('#modalButtons');
    box.innerHTML = '';
    const finish = v => { m.hidden = true; document.removeEventListener('keydown', onKey, true); resolve(v); };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(buttons.find(b => b.cancel)?.value ?? null); }
    };
    buttons.forEach(b => {
      const el = document.createElement('button');
      el.textContent = b.label;
      if (b.cls) el.className = b.cls;
      el.onclick = () => finish(b.value);
      box.appendChild(el);
    });
    m.hidden = false;
    document.addEventListener('keydown', onKey, true);
    const primary = $('.primary', box) || box.lastChild;
    setTimeout(() => primary && primary.focus(), 0);
  });
}

/* ============================== tabs ============================== */

function createTab({ path = null, content = '', eol = '\n', encoding = 'utf-8', mtime = null, lang = null } = {}, activate = true) {
  const el = document.createElement('section');
  el.className = 'doc';
  el.hidden = true;
  el.innerHTML = `<div class="scroller"><div class="page"><div class="gutter" aria-hidden="true"></div><div class="stack"><pre class="hl" aria-hidden="true"></pre><textarea autocomplete="off" autocapitalize="off"></textarea></div><article class="mdview" hidden></article></div></div>`;
  const t = {
    id: S.nextId++, path, saved: path ? content : '', eol, encoding, mtime,
    lang: lang || HL.detect(path), el,
    scroller: $('.scroller', el), page: $('.page', el), gutter: $('.gutter', el), pre: $('pre', el), ta: $('textarea', el),
    md: $('.mdview', el), previewing: false,
    lines: -1, label: '', wasDirty: false,
  };
  t.ta.value = content;
  docsEl.appendChild(el);
  bindDoc(t);
  applyMode(t);
  S.tabs.push(t);
  renderTabs();
  if (activate) activateTab(t);
  return t;
}

function activateTab(t) {
  if (!t) return;
  S.tabs.forEach(o => { o.el.hidden = o !== t; });
  S.active = t;
  renderTabs();
  updateTitle();
  updateStatus();
  updatePreviewBtn();
  if (F.open) computeMatches(false);
  render(t);
  if (!$('#modal').hidden) return;
  if (!F.open || document.activeElement !== $('#findInput')) t.ta.focus({ preventScroll: true });
  const tabEl = tabsEl.querySelector(`[data-id="${t.id}"]`);
  if (tabEl) tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

async function closeTab(t) {
  if (needsSave(t)) {
    const choice = await modal({
      title: t.path ? `Save changes to “${displayName(t)}”?` : 'Save this note?',
      text: t.path ? 'Your changes will be lost if you don’t save them.' : 'This note hasn’t been saved to a file. Closing it will delete it.',
      buttons: [
        { label: t.path ? 'Don’t save' : 'Discard', value: 'discard', cls: 'danger' },
        { label: 'Cancel', value: 'cancel', cancel: true },
        { label: 'Save', value: 'save', cls: 'primary' },
      ],
    });
    if (choice === 'cancel' || choice === null) return;
    if (choice === 'save' && !(await saveTab(t))) return;
  }
  const i = S.tabs.indexOf(t);
  S.tabs.splice(i, 1);
  t.el.remove();
  if (!S.tabs.length) createTab();
  else if (S.active === t) activateTab(S.tabs[Math.min(i, S.tabs.length - 1)]);
  else renderTabs();
}

function renderTabs() {
  tabsEl.innerHTML = '';
  for (const t of S.tabs) {
    const el = document.createElement('div');
    el.className = 'tab' + (t === S.active ? ' active' : '') + (t.path && isDirty(t) ? ' dirty' : '');
    el.dataset.id = t.id;
    el.title = t.path || 'Unsaved note';
    el.draggable = true;
    const name = displayName(t);
    t.label = name;
    t.wasDirty = !!t.path && isDirty(t);
    el.innerHTML = `<span class="name${t.path ? '' : ' untitled'}"></span><button class="close" title="Close (Ctrl+W)"><svg viewBox="0 0 16 16"><path d="m4 4 8 8M12 4l-8 8"/></svg></button>`;
    $('.name', el).textContent = name;
    el.addEventListener('mousedown', e => { if (e.button === 0 && !e.target.closest('.close')) activateTab(t); });
    el.addEventListener('auxclick', e => { if (e.button === 1) closeTab(t); });
    $('.close', el).addEventListener('click', e => { e.stopPropagation(); closeTab(t); });
    el.addEventListener('dragstart', e => { e.dataTransfer.setData('application/x-folio-tab', String(t.id)); el.classList.add('dragging'); });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
    el.addEventListener('dragover', e => { if (e.dataTransfer.types.includes('application/x-folio-tab')) e.preventDefault(); });
    el.addEventListener('drop', e => {
      const id = +e.dataTransfer.getData('application/x-folio-tab');
      if (!id) return;
      e.preventDefault(); e.stopPropagation();
      const from = S.tabs.findIndex(x => x.id === id), to = S.tabs.indexOf(t);
      if (from < 0 || from === to) return;
      const [moved] = S.tabs.splice(from, 1);
      S.tabs.splice(to, 0, moved);
      renderTabs();
    });
    tabsEl.appendChild(el);
  }
}

function updateTitle() {
  const t = S.active;
  if (!t) return;
  call('setTitle', { title: displayName(t), subtitle: t.path ? prettyDir(t.path) : '', dirty: !!t.path && isDirty(t) });
  document.title = displayName(t) + ' — Folio';
  updateSaveBtn();
}

// Lit while there's something to save (a new note with text in it, or a
// file with changes).
function updateSaveBtn() {
  const t = S.active;
  $('#saveBtn').classList.toggle('on', !!t && needsSave(t));
}

/* ============================== rendering ============================== */

function applyMode(t) {
  const code = isCode(t);
  const wrap = !code || S.settings.wrapCode;
  t.el.classList.toggle('code', code);
  t.el.classList.toggle('nowrap', !wrap);
  t.el.classList.toggle('numbers', code && !wrap && S.settings.lineNumbers);
  t.ta.setAttribute('wrap', wrap ? 'soft' : 'off');
  t.ta.spellcheck = !code && S.settings.spellcheck;
  t.ta.placeholder = code ? '' : 'Start writing…';
  t.lines = -1;
  if (t.previewing && t.lang !== 'markdown') setPreview(t, false);
  if (t === S.active) updatePreviewBtn();
}

/* ============================== markdown preview ============================== */

// The document as it reads, for Markdown: read-only, in the page's own
// font and width. Editing again: the same button, Ctrl+Shift+M, or Esc.
function setPreview(t, on) {
  if (!t) return;
  on = on && t.lang === 'markdown';
  t.previewing = on;
  if (on) t.md.innerHTML = MD.render(t.ta.value);
  t.md.hidden = !on;
  $('.stack', t.el).hidden = on;
  t.el.classList.toggle('previewing', on);
  if (t === S.active) updatePreviewBtn();
  if (!on) t.ta.focus({ preventScroll: true });
}

function updatePreviewBtn() {
  const t = S.active, b = $('#previewBtn');
  b.hidden = !t || t.lang !== 'markdown';
  b.classList.toggle('on', !!t && t.previewing);
}

function render(t, plain = false) {
  const text = t.ta.value;
  const f = F.open && S.active === t;
  clearTimeout(t.colourTimer);
  if (plain) {
    // The same text, so the same layout: the caret and selection stay put.
    t.pre.textContent = text + ' ';
  } else {
    try {
      const tokens = text.length > BIG ? [['', text]] : HL.tokenize(text, t.lang);
      t.pre.innerHTML = HL.render(tokens, f ? F.matches : null, f ? F.cur : -1) + ' ';
    } catch (err) {
      // The textarea text is transparent, so never leave the visible layer blank.
      t.pre.textContent = text + ' ';
      reportError(err);
    }
  }
  if (t.el.classList.contains('numbers')) {
    let n = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++;
    if (n !== t.lines) {
      t.lines = n;
      let s = '';
      for (let i = 1; i <= n; i++) s += i + '\n';
      t.gutter.textContent = s;
    }
  }
  t.ta.scrollTop = 0;
  t.ta.scrollLeft = 0;
}

// Pixel rect of the character at `offset`, measured from the highlight layer (same layout as the textarea).
function charRect(t, offset) {
  const walker = document.createTreeWalker(t.pre, NodeFilter.SHOW_TEXT);
  let n, acc = 0;
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (acc + len > offset) {
      const r = document.createRange();
      r.setStart(n, offset - acc);
      r.setEnd(n, offset - acc + 1);
      const rects = r.getClientRects();
      return rects.length ? rects[rects.length > 1 && n.nodeValue[offset - acc] === '\n' ? 0 : 0] : r.getBoundingClientRect();
    }
    acc += len;
  }
  return null;
}

function revealCaret(t, center = false) {
  const ta = t.ta;
  const pos = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
  const r = charRect(t, pos);
  if (!r) return;
  const sr = t.scroller.getBoundingClientRect();
  const lh = r.height || 24;
  if (center || (S.settings.typewriter && !isCode(t))) {
    t.scroller.scrollTop += (r.top + lh / 2) - (sr.top + sr.height * 0.45);
  } else {
    const margin = Math.min(lh * 3, sr.height / 4);
    if (r.top < sr.top + margin) t.scroller.scrollTop -= sr.top + margin - r.top;
    else if (r.bottom > sr.bottom - margin) t.scroller.scrollTop += r.bottom - (sr.bottom - margin);
  }
  if (isCode(t)) {
    const left = sr.left + (t.el.classList.contains('numbers') ? t.gutter.offsetWidth : 0) + 24;
    if (r.left < left) t.scroller.scrollLeft -= left - r.left;
    else if (r.right > sr.right - 48) t.scroller.scrollLeft += r.right - (sr.right - 48);
  }
}

/* ============================== editing ============================== */

const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End']);

function bindDoc(t) {
  const ta = t.ta;
  ta.addEventListener('input', () => {
    if (ta.value.length > QUICK) {
      render(t, true);
      t.colourTimer = setTimeout(() => render(t), COLOUR_AFTER);
    } else {
      render(t);
    }
    onChange(t);
    requestAnimationFrame(() => revealCaret(t));
    if (S.settings.fade) document.body.classList.add('typing');
  });
  ta.addEventListener('scroll', () => { ta.scrollTop = 0; ta.scrollLeft = 0; });
  ta.addEventListener('keydown', e => onEditorKey(t, e));
  ta.addEventListener('keyup', e => { if (NAV_KEYS.has(e.key)) requestAnimationFrame(() => revealCaret(t)); updatePos(); });
  ta.addEventListener('mouseup', updatePos);
  ta.addEventListener('select', updatePos);
  ta.addEventListener('focus', updatePos);
  // Clicks in the margins focus the editor; below the text puts the caret at the end.
  t.scroller.addEventListener('mousedown', e => {
    if (e.target === ta || e.button !== 0) return;
    e.preventDefault();
    const below = e.clientY > ta.getBoundingClientRect().bottom - 4;
    ta.focus({ preventScroll: true });
    if (below) ta.setSelectionRange(ta.value.length, ta.value.length);
    updatePos();
  });
}

function onChange(t) {
  const dirty = !!t.path && isDirty(t);
  if (dirty !== t.wasDirty || displayName(t) !== t.label) { renderTabs(); updateTitle(); }
  updateStatusSoon();
  updateSaveBtn();
  if (F.open) computeMatches(false);
  if (S.settings.autosave && t.path && dirty) autosaveSoon(t);
}

const autosaveTimers = new Map();
function autosaveSoon(t) {
  clearTimeout(autosaveTimers.get(t.id));
  autosaveTimers.set(t.id, setTimeout(() => { if (S.tabs.includes(t) && isDirty(t)) saveTab(t, false, true); }, 1200));
}

// Replace [s, e) through the editing pipeline so it lands on the native undo stack.
function replaceRange(t, s, e, text, selS = null, selE = selS) {
  const ta = t.ta;
  ta.focus({ preventScroll: true });
  ta.setSelectionRange(s, e);
  const ok = text === '' ? document.execCommand('delete') : document.execCommand('insertText', false, text);
  if (!ok) {
    ta.setRangeText(text, s, e, 'end');
    ta.dispatchEvent(new Event('input'));
  }
  if (selS !== null) ta.setSelectionRange(selS, selE);
}

function lineBounds(ta) {
  const v = ta.value;
  const s = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
  let endSel = ta.selectionEnd;
  if (endSel > ta.selectionStart && v[endSel - 1] === '\n') endSel--;
  let e = v.indexOf('\n', endSel);
  if (e < 0) e = v.length;
  return [s, e];
}

function indentLines(t, outdent) {
  const ta = t.ta, unit = indentUnit();
  const [s, e] = lineBounds(ta);
  const lines = ta.value.slice(s, e).split('\n');
  const out = lines.map(l => {
    if (!outdent) return l.length ? unit + l : l;
    if (l.startsWith('\t')) return l.slice(1);
    const m = l.match(/^ {1,}/);
    return m ? l.slice(Math.min(m[0].length, S.settings.tabSize)) : l;
  }).join('\n');
  replaceRange(t, s, e, out, s, s + out.length);
}

function toggleComment(t) {
  const L = HL.LANGS[t.lang] || {};
  const ta = t.ta;
  const [s, e] = lineBounds(ta);
  const block = ta.value.slice(s, e);
  if (!L.line && (L.markup || L.css || L.block)) {
    const [o, c] = L.markup ? ['<!-- ', ' -->'] : ['/* ', ' */'];
    const trimmed = block.trim();
    const out = trimmed.startsWith(o.trim()) && trimmed.endsWith(c.trim())
      ? block.replace(new RegExp('^(\\s*)' + o.trim().replace(/[*]/g, '\\*') + ' ?'), '$1').replace(new RegExp(' ?' + c.trim().replace(/[*]/g, '\\*') + '(\\s*)$'), '$1')
      : block.replace(/^(\s*)/, '$1' + o) + c;
    replaceRange(t, s, e, out, s, s + out.length);
    return;
  }
  const p = L.line || (L.conf ? '#' : null);
  if (!p) return;
  const lines = block.split('\n');
  const filled = lines.filter(l => l.trim());
  const all = filled.length && filled.every(l => l.trimStart().startsWith(p));
  const minIndent = Math.min(...filled.map(l => l.match(/^\s*/)[0].length));
  const out = lines.map(l => {
    if (!l.trim()) return l;
    if (all) return l.replace(new RegExp('^(\\s*)' + p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&') + ' ?'), '$1');
    return l.slice(0, minIndent) + p + ' ' + l.slice(minIndent);
  }).join('\n');
  replaceRange(t, s, e, out, s, s + out.length);
}

function moveLines(t, dir) {
  const ta = t.ta, v = ta.value;
  const [s, e] = lineBounds(ta);
  const selS = ta.selectionStart - s, selE = ta.selectionEnd - s;
  const block = v.slice(s, e);
  if (dir < 0) {
    if (s === 0) return;
    const ps = v.lastIndexOf('\n', s - 2) + 1;
    const prev = v.slice(ps, s - 1);
    replaceRange(t, ps, e, block + '\n' + prev, ps + selS, ps + selE);
  } else {
    if (e >= v.length) return;
    let ne = v.indexOf('\n', e + 1);
    if (ne < 0) ne = v.length;
    const next = v.slice(e + 1, ne);
    const ns = s + next.length + 1;
    replaceRange(t, s, ne, next + '\n' + block, ns + selS, ns + selE);
  }
}

function duplicateLines(t) {
  const ta = t.ta;
  const [s, e] = lineBounds(ta);
  const block = ta.value.slice(s, e);
  const a = ta.selectionStart, b = ta.selectionEnd, d = block.length + 1;
  replaceRange(t, e, e, '\n' + block, a + d, b + d);
}

function onEditorKey(t, e) {
  const ta = t.ta, v = ta.value;
  const code = isCode(t);
  const mod = e.ctrlKey || e.metaKey;

  if (e.key === 'Tab' && !mod && !e.altKey) {
    e.preventDefault();
    const multi = v.slice(ta.selectionStart, ta.selectionEnd).includes('\n');
    if (e.shiftKey || multi) indentLines(t, e.shiftKey);
    else {
      // In lists, Tab indents the whole item.
      const ls = v.lastIndexOf('\n', ta.selectionStart - 1) + 1;
      if (!code && /^\s*([-*+]|\d+[.)])\s/.test(v.slice(ls, ta.selectionStart + 1))) indentLines(t, false);
      else replaceRange(t, ta.selectionStart, ta.selectionEnd, code ? indentUnit() : '\t');
    }
    return;
  }

  if (e.key === 'Enter' && !mod && !e.altKey && !e.shiftKey && ta.selectionStart === ta.selectionEnd) {
    const pos = ta.selectionStart;
    const ls = v.lastIndexOf('\n', pos - 1) + 1;
    const line = v.slice(ls, pos);
    const indent = line.match(/^[ \t]*/)[0];
    if (code) {
      e.preventDefault();
      const before = line.trimEnd().slice(-1), after = v[pos];
      const opens = '{[(', pairs = { '{': '}', '[': ']', '(': ')' };
      if (opens.includes(before) && after === pairs[before]) {
        const ins = '\n' + indent + indentUnit() + '\n' + indent;
        replaceRange(t, pos, pos, ins, pos + indent.length + indentUnit().length + 1);
      } else {
        const extra = opens.includes(before) || (before === ':' && ['py', 'conf'].includes(t.lang)) ? indentUnit() : '';
        replaceRange(t, pos, pos, '\n' + indent + extra);
      }
      return;
    }
    // Continue Markdown-style lists and block quotes.
    const m = line.match(/^(\s*)([-*+]|(\d+)([.)]))(\s+)(\[[ xX]\]\s+)?/) || line.match(/^(\s*)(>)(\s?)/);
    if (m) {
      e.preventDefault();
      if (line.slice(m[0].length).trim() === '' && pos === ls + line.length) {
        replaceRange(t, ls, pos, '');            // empty item: end the list
        return;
      }
      let marker;
      if (m[2] === '>') marker = m[1] + '> ';
      else if (m[3]) marker = m[1] + (parseInt(m[3], 10) + 1) + m[4] + m[5];
      else marker = m[1] + m[2] + m[5];
      if (m[6]) marker += '[ ] ';
      replaceRange(t, pos, pos, '\n' + marker);
      return;
    }
    if (indent) { e.preventDefault(); replaceRange(t, pos, pos, '\n' + indent); }
    return;
  }

  if (mod && !e.shiftKey && e.key === '/' && code) { e.preventDefault(); toggleComment(t); return; }
  if (mod && e.shiftKey && (e.key === 'D' || e.key === 'd')) { e.preventDefault(); duplicateLines(t); return; }
  if (e.altKey && !mod && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) { e.preventDefault(); moveLines(t, e.key === 'ArrowUp' ? -1 : 1); return; }
  if (mod && (e.key === ']' || e.key === '[')) { e.preventDefault(); indentLines(t, e.key === '['); return; }
}

/* ============================== files ============================== */

function openFileData(f) {
  if (!f) return;
  if (f.error) { toast(f.error); return; }
  const existing = S.tabs.find(t => t.path === f.path);
  if (existing) { activateTab(existing); return; }
  // Replace a lone empty untitled tab rather than piling up tabs.
  const blank = S.tabs.length === 1 && !S.tabs[0].path && !S.tabs[0].ta.value ? S.tabs[0] : null;
  const t = createTab(f);
  if (blank) { S.tabs.splice(S.tabs.indexOf(blank), 1); blank.el.remove(); renderTabs(); }
  return t;
}

async function openDialog() {
  const files = await call('open', { dir: S.active && S.active.path ? S.active.path.slice(0, S.active.path.lastIndexOf('/')) : null });
  if (files) files.forEach(openFileData);
}

async function saveTab(t, as = false, quiet = false) {
  const content = t.ta.value;
  let r;
  if (!t.path || as) {
    r = await call('saveAs', { content, name: suggestName(t), path: t.path, eol: t.eol, encoding: t.encoding });
    if (!r) return false;
    if (r.error) { toast(r.error); return false; }
    const wasText = !isCode(t);
    t.path = r.path;
    const detected = HL.detect(r.path);
    if (detected !== 'text' || wasText) { t.lang = detected; applyMode(t); }
  } else {
    r = await call('save', { path: t.path, content, eol: t.eol, encoding: t.encoding });
    if (!r || r.error) { toast(r ? r.error : 'Could not save'); return false; }
  }
  t.mtime = r.mtime;
  t.saved = content;
  render(t);
  renderTabs();
  updateTitle();
  updateStatus();
  if (!quiet) toast('Saved ' + basename(t.path));
  return true;
}

async function checkDiskChanges() {
  const tabs = S.tabs.filter(t => t.path);
  if (!tabs.length || !native) return;
  const stats = await call('stat', { paths: tabs.map(t => t.path) });
  for (const t of tabs) {
    const m = stats[t.path];
    if (m == null || t.mtime == null || m === t.mtime || isDirty(t)) continue;
    const [f] = await call('read', { paths: [t.path] });
    if (!f || f.error) continue;
    const sel = [t.ta.selectionStart, t.ta.selectionEnd], top = t.scroller.scrollTop;
    t.ta.value = f.content;
    t.saved = f.content;
    t.mtime = f.mtime;
    t.ta.setSelectionRange(...sel);
    render(t);
    t.scroller.scrollTop = top;
    toast(`Reloaded ${basename(t.path)} (changed on disk)`);
  }
}

async function requestClose() {
  // Nothing is remembered after closing, so unsaved notes count too.
  const dirty = S.tabs.filter(needsSave);
  if (dirty.length) {
    const names = dirty.map(displayName).join(', ');
    const choice = await modal({
      title: dirty.length === 1 ? `Save changes to “${names}”?` : `Save changes to ${dirty.length} documents?`,
      text: (dirty.length === 1 ? '' : names + '\n\n') + 'Folio doesn’t keep anything after it closes — unsaved text will be gone.',
      buttons: [
        { label: 'Don’t save', value: 'discard', cls: 'danger' },
        { label: 'Cancel', value: 'cancel', cancel: true },
        { label: dirty.length === 1 ? 'Save' : 'Save all', value: 'save', cls: 'primary' },
      ],
    });
    if (choice === 'cancel' || choice === null) return;
    if (choice === 'save') {
      for (const t of dirty) { activateTab(t); if (!(await saveTab(t, false, true))) return; }
    }
  }
  call('quit');
}

/* ============================== settings ============================== */

// Settings that change how documents are built; everything else is pure CSS.
const MODE_KEYS = new Set(['spellcheck', 'wrapCode', 'lineNumbers']);

function applySettings(changed = null) {
  const s = S.settings, root = document.documentElement;
  root.dataset.theme = s.theme;
  root.style.setProperty('--text-font', `var(--${s.textFont})`);
  root.style.setProperty('--text-size', s.fontSize + 'px');
  root.style.setProperty('--code-size', s.codeFontSize + 'px');
  root.style.setProperty('--measure', s.measure + 'ch');
  root.style.setProperty('--lh', s.lineHeight);
  root.style.setProperty('--tab', s.tabSize);
  document.body.classList.toggle('typewriter', s.typewriter);
  document.body.classList.toggle('fade', s.fade);
  if (!changed || MODE_KEYS.has(changed)) S.tabs.forEach(t => { applyMode(t); render(t); });
  syncSettingsUI();
  if (!changed || changed === 'theme') {
    const cs = getComputedStyle(root);
    const v = k => cs.getPropertyValue(k).trim();
    call('setTheme', { bg: v('--bg'), fg: v('--fg'), dark: ['night', 'ink'].includes(s.theme) });
  }
}
const saveSettingsSoon = debounce(() => call('saveSettings', { settings: S.settings }), 600);
let settingsFrame = 0, changedKeys = new Set();
function setSetting(k, v) {
  S.settings[k] = v;
  changedKeys.add(k);
  // Coalesce rapid slider input into one update per frame.
  if (settingsFrame) return;
  settingsFrame = requestAnimationFrame(() => {
    settingsFrame = 0;
    const keys = [...changedKeys];
    changedKeys.clear();
    keys.forEach(key => applySettings(key));
    saveSettingsSoon();
    if (S.active) revealCaret(S.active);
  });
}

function syncSettingsUI() {
  const s = S.settings;
  $$('#themeSwatches button').forEach(b => b.classList.toggle('on', b.dataset.theme === s.theme));
  $$('#fontSeg button').forEach(b => b.classList.toggle('on', b.dataset.font === s.textFont));
  $('#sizeIn').value = s.fontSize; $('#sizeOut').textContent = s.fontSize + ' px';
  $('#measureIn').value = s.measure; $('#measureOut').textContent = s.measure + ' ch';
  $('#lhIn').value = s.lineHeight; $('#lhOut').textContent = (+s.lineHeight).toFixed(2);
  $('#codeSizeIn').value = s.codeFontSize; $('#codeSizeOut').textContent = s.codeFontSize + ' px';
  $('#optSpell').checked = s.spellcheck;
  $('#optTypewriter').checked = s.typewriter;
  $('#optFade').checked = s.fade;
  $('#optAutosave').checked = s.autosave;
  $('#optWrapCode').checked = s.wrapCode;
  $('#optLineNumbers').checked = s.lineNumbers;
  $('#optSpaces').checked = s.useSpaces;
  $('#optTab').value = String(s.tabSize);
}

function bindSettingsUI() {
  $$('#themeSwatches button').forEach(b => b.onclick = () => setSetting('theme', b.dataset.theme));
  $$('#fontSeg button').forEach(b => b.onclick = () => setSetting('textFont', b.dataset.font));
  const range = (id, key) => $(id).addEventListener('input', e => setSetting(key, +e.target.value));
  range('#sizeIn', 'fontSize'); range('#measureIn', 'measure'); range('#lhIn', 'lineHeight'); range('#codeSizeIn', 'codeFontSize');
  const sw = (id, key) => $(id).addEventListener('change', e => setSetting(key, e.target.checked));
  sw('#optSpell', 'spellcheck'); sw('#optTypewriter', 'typewriter'); sw('#optFade', 'fade'); sw('#optAutosave', 'autosave');
  sw('#optWrapCode', 'wrapCode'); sw('#optLineNumbers', 'lineNumbers'); sw('#optSpaces', 'useSpaces');
  $('#optTab').addEventListener('change', e => setSetting('tabSize', +e.target.value));
}

/* ============================== status bar ============================== */

function updateStatus() {
  const t = S.active;
  if (!t) return;
  const text = t.ta.value;
  const L = HL.LANGS[t.lang] || HL.LANGS.text;
  $('#langBtn').textContent = L.name;
  const sel = text.slice(t.ta.selectionStart, t.ta.selectionEnd);
  const src = sel || text;
  const words = text.length > BIG * 4 ? 0 : (src.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
  if (isCode(t)) {
    let lines = 1;
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) lines++;
    $('#stWords').textContent = sel ? `${sel.length.toLocaleString()} selected` : `${lines.toLocaleString()} lines`;
  } else {
    const mins = Math.max(1, Math.round(words / 230));
    $('#stWords').textContent = sel
      ? `${words.toLocaleString()} of ${(text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length.toLocaleString()} words selected`
      : `${words.toLocaleString()} words · ${src.length.toLocaleString()} characters${words ? ` · ${mins} min read` : ''}`;
  }
  $('#stEol').textContent = (t.encoding || 'utf-8').toUpperCase() + (t.eol === '\r\n' ? ' · CRLF' : '');
  const st = $('#stSaved');
  if (!t.path) { st.textContent = t.ta.value ? 'Not saved' : ''; st.className = ''; }
  else if (isDirty(t)) { st.textContent = 'Edited'; st.className = 'unsaved'; }
  else { st.textContent = 'Saved'; st.className = ''; }
  updatePos();
}
const updateStatusSoon = debounce(updateStatus, 120);

function updatePos() {
  const t = S.active;
  if (!t) return;
  const pos = t.ta.selectionDirection === 'backward' ? t.ta.selectionStart : t.ta.selectionEnd;
  const before = t.ta.value.slice(0, pos);
  const line = (before.match(/\n/g) || []).length + 1;
  const col = pos - before.lastIndexOf('\n');
  $('#stPos').textContent = `Ln ${line}, Col ${col}`;
  if (t.ta.selectionStart !== t.ta.selectionEnd || $('#stWords').dataset.sel) updateStatusSoon();
  $('#stWords').dataset.sel = t.ta.selectionStart !== t.ta.selectionEnd ? '1' : '';
}

function showLangMenu() {
  const menu = $('#langMenu');
  if (!menu.hidden) { menu.hidden = true; return; }
  menu.innerHTML = '';
  const add = id => {
    const b = document.createElement('button');
    b.textContent = HL.LANGS[id].name;
    b.classList.toggle('on', S.active.lang === id);
    b.onclick = () => { const t = S.active; t.lang = id; applyMode(t); render(t); updateStatus(); menu.hidden = true; t.ta.focus(); };
    menu.appendChild(b);
  };
  add('text'); add('markdown');
  menu.appendChild(document.createElement('hr'));
  Object.keys(HL.LANGS).filter(id => HL.isCode(id)).sort((a, b) => HL.LANGS[a].name.localeCompare(HL.LANGS[b].name)).forEach(add);
  const r = $('#langBtn').getBoundingClientRect();
  menu.style.left = r.left + 'px';
  menu.style.bottom = (innerHeight - r.top + 6) + 'px';
  menu.style.top = 'auto';
  menu.hidden = false;
}

/* ============================== find & replace ============================== */

function openFind(replace = false) {
  F.open = true;
  $('#findbar').hidden = false;
  if (replace) $('#replaceRow').hidden = false;
  const t = S.active, sel = t.ta.value.slice(t.ta.selectionStart, t.ta.selectionEnd);
  if (sel && !sel.includes('\n')) $('#findInput').value = sel;
  const input = replace && $('#findInput').value ? $('#replaceInput') : $('#findInput');
  input.focus(); input.select();
  computeMatches(true);
}

function closeFind() {
  F.open = false;
  $('#findbar').hidden = true;
  F.matches = []; F.cur = -1;
  const t = S.active;
  render(t);
  t.ta.focus({ preventScroll: true });
}

function findRegex() {
  const q = $('#findInput').value;
  if (!q) return null;
  try { return new RegExp(F.re ? q : q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (F.cs ? '' : 'i') + (F.re ? 'm' : '')); }
  catch { return 'error'; }
}

function computeMatches(jump) {
  const t = S.active;
  const re = findRegex();
  $('#findInput').parentElement.classList.toggle('error', re === 'error');
  F.matches = [];
  if (re && re !== 'error') {
    const text = t.ta.value;
    let m;
    while ((m = re.exec(text)) && F.matches.length < 20000) {
      if (m[0] === '') { re.lastIndex++; continue; }
      F.matches.push([m.index, m.index + m[0].length]);
    }
  }
  const from = t.ta.selectionStart;
  F.cur = F.matches.length ? Math.max(0, F.matches.findIndex(m => m[0] >= from)) : -1;
  if (F.cur < 0 && F.matches.length) F.cur = 0;
  render(t);
  updateFindCount();
  if (jump && F.cur >= 0) selectMatch();
}

function updateFindCount() {
  const q = $('#findInput').value;
  $('#findCount').textContent = !q ? '' : F.matches.length ? `${F.cur + 1} of ${F.matches.length}` : 'No results';
}

function selectMatch() {
  const t = S.active, m = F.matches[F.cur];
  if (!m) return;
  t.ta.setSelectionRange(m[0], m[1]);
  render(t);
  updateFindCount();
  requestAnimationFrame(() => {
    const r = charRect(t, m[0]), sr = t.scroller.getBoundingClientRect();
    if (r && (r.top < sr.top + 60 || r.bottom > sr.bottom - 60)) revealCaret(t, true);
    else revealCaret(t);
  });
}

function stepMatch(dir) {
  if (!F.matches.length) return;
  F.cur = (F.cur + dir + F.matches.length) % F.matches.length;
  selectMatch();
}

function replacement(matchText) {
  const r = $('#replaceInput').value;
  if (!F.re) return r;
  const re = findRegex();
  return re && re !== 'error' ? matchText.replace(new RegExp(re.source, re.flags.replace('g', '')), r) : r;
}

function replaceOne() {
  const t = S.active, m = F.matches[F.cur];
  if (!m) return;
  const rep = replacement(t.ta.value.slice(m[0], m[1]));
  replaceRange(t, m[0], m[1], rep, m[0] + rep.length);
  computeMatches(true);
  $('#replaceInput').focus();
}

function replaceAll() {
  const t = S.active, re = findRegex();
  if (!re || re === 'error' || !F.matches.length) return;
  const n = F.matches.length;
  const out = t.ta.value.replace(re, F.re ? $('#replaceInput').value : () => $('#replaceInput').value);
  const sel = t.ta.selectionStart;
  replaceRange(t, 0, t.ta.value.length, out, Math.min(sel, out.length));
  computeMatches(false);
  toast(`Replaced ${n} occurrence${n === 1 ? '' : 's'}`);
  $('#replaceInput').focus();
}

function bindFind() {
  const fi = $('#findInput'), ri = $('#replaceInput');
  fi.addEventListener('input', () => computeMatches(true));
  fi.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); stepMatch(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  ri.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); (e.ctrlKey ? replaceAll : replaceOne)(); }
    if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  $('#findNext').onclick = () => stepMatch(1);
  $('#findPrev').onclick = () => stepMatch(-1);
  $('#findClose').onclick = closeFind;
  $('#findCase').onclick = e => { F.cs = !F.cs; e.currentTarget.classList.toggle('on', F.cs); computeMatches(true); fi.focus(); };
  $('#findRegex').onclick = e => { F.re = !F.re; e.currentTarget.classList.toggle('on', F.re); computeMatches(true); fi.focus(); };
  $('#replaceToggle').onclick = () => { const row = $('#replaceRow'); row.hidden = !row.hidden; (row.hidden ? fi : ri).focus(); };
  $('#replaceOne').onclick = replaceOne;
  $('#replaceAll').onclick = replaceAll;
}

/* ============================== global keys & chrome ============================== */

function zoom(d) {
  if (S.active && isCode(S.active)) setSetting('codeFontSize', d === 0 ? DEFAULTS.codeFontSize : Math.min(22, Math.max(11, S.settings.codeFontSize + d)));
  else setSetting('fontSize', d === 0 ? DEFAULTS.fontSize : Math.min(30, Math.max(13, S.settings.fontSize + d)));
}

function toggleSettings(force) {
  const p = $('#settings');
  p.hidden = force !== undefined ? !force : !p.hidden;
  $('#settingsBtn').classList.toggle('on', !p.hidden);
}

function toggleFocus() {
  document.body.classList.toggle('focus');
  $('#focusBtn').classList.toggle('on', document.body.classList.contains('focus'));
  if (document.body.classList.contains('focus')) toast('Focus mode — Ctrl+Shift+F to exit');
}

function showShortcuts() {
  toggleSettings(false);
  const rows = [
    ['New note', 'Ctrl+N'], ['Open file', 'Ctrl+O'], ['Save / Save as', 'Ctrl+S / Ctrl+Shift+S'], ['Close tab', 'Ctrl+W'],
    ['Next / previous tab', 'Ctrl+Tab / Ctrl+Shift+Tab'], ['Jump to tab', 'Ctrl+1 … 9'],
    ['Find / Replace', 'Ctrl+F / Ctrl+H'], ['Text size', 'Ctrl+= / Ctrl+− / Ctrl+0'],
    ['Focus mode', 'Ctrl+Shift+F'], ['Full screen', 'F11'], ['Settings', 'Ctrl+,'],
    ['Indent / outdent', 'Tab / Shift+Tab'], ['Move line', 'Alt+↑ / Alt+↓'], ['Duplicate line', 'Ctrl+Shift+D'],
    ['Toggle comment (code)', 'Ctrl+/'], ['Quit', 'Ctrl+Q'],
  ];
  const html = '<div class="shortcuts">' + rows.map(([a, b]) => `<span>${a}</span><kbd>${b}</kbd>`).join('') + '</div>';
  modal({ title: 'Keyboard shortcuts', html, buttons: [{ label: 'Done', value: true, cls: 'primary', cancel: true }] }).then(() => S.active.ta.focus());
}

function onGlobalKey(e) {
  if (!$('#modal').hidden) return;
  const mod = e.ctrlKey || e.metaKey, k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const t = S.active;
  const go = fn => { e.preventDefault(); fn(); };
  if (mod && !e.shiftKey && k === 'n') return go(() => createTab());
  if (mod && !e.shiftKey && k === 'o') return go(openDialog);
  if (mod && k === 's') return go(() => saveTab(t, e.shiftKey));
  if (mod && !e.shiftKey && k === 'w') return go(() => closeTab(t));
  if (mod && !e.shiftKey && k === 'q') return go(requestClose);
  if (mod && !e.shiftKey && k === 'f') return go(() => openFind(false));
  if (mod && !e.shiftKey && k === 'h') return go(() => openFind(true));
  if (mod && e.shiftKey && k === 'f') return go(toggleFocus);
  if (mod && e.shiftKey && k === 'm' && t && t.lang === 'markdown') return go(() => setPreview(t, !t.previewing));
  if (mod && k === ',') return go(() => toggleSettings());
  if (mod && (k === '=' || k === '+')) return go(() => zoom(1));
  if (mod && k === '-') return go(() => zoom(-1));
  if (mod && k === '0') return go(() => zoom(0));
  if (k === 'F11') return go(() => call('fullscreen'));
  if (k === 'F3') return go(() => F.open ? stepMatch(e.shiftKey ? -1 : 1) : openFind());
  if (mod && (k === 'Tab' || k === 'PageDown' || k === 'PageUp')) {
    return go(() => {
      const dir = k === 'PageUp' || (k === 'Tab' && e.shiftKey) ? -1 : 1;
      const i = S.tabs.indexOf(t);
      activateTab(S.tabs[(i + dir + S.tabs.length) % S.tabs.length]);
    });
  }
  if (mod && !e.shiftKey && /^[1-9]$/.test(k)) return go(() => activateTab(k === '9' ? S.tabs[S.tabs.length - 1] : S.tabs[+k - 1]));
  if (k === 'Escape') {
    if (!$('#langMenu').hidden) return go(() => { $('#langMenu').hidden = true; });
    if (!$('#settings').hidden) return go(() => { toggleSettings(false); t.ta.focus(); });
    if (F.open) return go(closeFind);
    if (document.body.classList.contains('focus')) return go(toggleFocus);
    if (t && t.previewing) return go(() => setPreview(t, false));
  }
}

function bindChrome() {
  document.addEventListener('keydown', onGlobalKey);
  $('#newBtn').onclick = () => createTab();
  $('#openBtn').onclick = openDialog;
  $('#focusBtn').onclick = toggleFocus;
  $('#saveBtn').onclick = () => S.active && saveTab(S.active);
  $('#previewBtn').onclick = () => setPreview(S.active, !(S.active && S.active.previewing));
  $('#settingsBtn').onclick = e => { e.stopPropagation(); toggleSettings(); };
  $('#shortcutsBtn').onclick = showShortcuts;
  $('#langBtn').onclick = e => { e.stopPropagation(); showLangMenu(); };
  document.addEventListener('mousedown', e => {
    if (!e.target.closest('#settings, #settingsBtn')) toggleSettings(false);
    if (!e.target.closest('#langMenu, #langBtn')) $('#langMenu').hidden = true;
  });
  document.addEventListener('mousemove', () => document.body.classList.remove('typing'));
  tabsEl.addEventListener('dblclick', e => { if (e.target === tabsEl) createTab(); });
  $('#tabbar').addEventListener('dblclick', e => { if (e.target.classList.contains('spacer')) createTab(); });
  window.addEventListener('focus', checkDiskChanges);
  window.addEventListener('blur', () => {
    if (S.settings.autosave) S.tabs.filter(t => t.path && isDirty(t)).forEach(t => saveTab(t, false, true));
    });

  // Drop files from the file manager to open them.
  let dragDepth = 0;
  const hint = () => $('#dropHint') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'dropHint', textContent: 'Drop to open' }));
  const isFiles = e => e.dataTransfer && [...e.dataTransfer.types].some(x => x === 'Files' || x === 'text/uri-list');
  document.addEventListener('dragenter', e => { if (isFiles(e)) { dragDepth++; hint().hidden = false; } });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; hint().hidden = true; } });
  document.addEventListener('dragover', e => { if (isFiles(e)) e.preventDefault(); });
  document.addEventListener('drop', async e => {
    dragDepth = 0; hint().hidden = true;
    if (!isFiles(e)) return;
    e.preventDefault();
    const uris = (e.dataTransfer.getData('text/uri-list') || '').split(/\r?\n/).filter(u => u.startsWith('file://'));
    if (uris.length && native) {
      const files = await call('read', { paths: uris.map(u => decodeURIComponent(new URL(u).pathname)) });
      files.forEach(openFileData);
    } else {
      for (const f of e.dataTransfer.files) createTab({ content: await f.text(), lang: HL.detect(f.name) });
    }
  });
}

/* ============================== boot ============================== */

async function boot() {
  bindChrome();
  bindFind();
  bindSettingsUI();
  const init = await call('init') || {};
  S.home = init.home || '';
  S.settings = { ...DEFAULTS, ...(init.settings || {}) };
  applySettings();
  createTab();
  (init.files || []).forEach(openFileData);
  document.fonts.ready.then(() => S.tabs.forEach(render));
}

boot();
