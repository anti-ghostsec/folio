// Markdown to HTML for the preview. Small and strict: everything from the
// file is escaped (raw HTML in a .md file is shown as text, never run), and
// pictures aren't loaded, so reading a document never tells a server so;
// a picture shows as its description. Links keep their address; clicking
// one opens it in the browser (folio.py), never inside Folio.
'use strict';

const MD = (() => {
  const esc = s => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // Only addresses a click can safely go to.
  const safeHref = url => {
    const u = url.trim();
    if (/^(https?:|mailto:)/i.test(u)) return u;
    if (/^#[\w-]*$/.test(u)) return u;
    return null;
  };

  // Inline markup, on text that is escaped first. Code spans are cut out
  // before anything else so their contents stay literal.
  function inline(text) {
    const codes = [];
    let s = text.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, _t, code) => {
      codes.push(`<code>${esc(code.trim())}</code>`);
      return `\u0000${codes.length - 1}\u0000`;
    });
    // Backslash escapes: the character stands for itself.
    const escaped = [];
    s = s.replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, (_, c) => { escaped.push(c); return `\u0001${escaped.length - 1}\u0001`; });
    s = esc(s);
    // Pictures: their description, not the picture.
    s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (_, alt) => `<span class="md-img" title="Picture (not loaded)">🖼 ${alt || 'picture'}</span>`);
    s = s.replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (m, label, href, title) => {
      const h = safeHref(href.replace(/&amp;/g, '&'));
      if (!h) return label;
      return `<a href="${esc(h)}"${title ? ` title="${title}"` : ''}>${label}</a>`;
    });
    s = s.replace(/&lt;((?:https?:\/\/|mailto:)[^\s&]+)&gt;/g, (_, u) => `<a href="${u}">${u}</a>`);
    s = s.replace(/(\*\*|__)(?=\S)([\s\S]*?\S)\1/g, '<strong>$2</strong>');
    s = s.replace(/(^|[^*\w])(\*|_)(?=\S)([\s\S]*?\S)\2(?![*\w])/g, '$1<em>$3</em>');
    s = s.replace(/~~(?=\S)([\s\S]*?\S)~~/g, '<del>$1</del>');
    s = s.replace(/ {2,}\n/g, '<br>\n');
    s = s.replace(/\u0001(\d+)\u0001/g, (_, i) => esc(escaped[+i]));
    s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
    return s;
  }

  const isRule = l => /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
  const listItem = l => l.match(/^( *)([-*+]|\d{1,9}[.)])( +|$)(.*)$/);
  const isTableSep = l => /^ *\|? *:?-+:? *(\| *:?-+:? *)*\|? *$/.test(l) && l.includes('-');
  const cells = l => l.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map(c => c.trim());

  function blocks(lines) {
    let out = '';
    let i = 0;
    const para = [];
    const flush = () => {
      if (para.length) out += `<p>${inline(para.join('\n'))}</p>\n`;
      para.length = 0;
    };
    while (i < lines.length) {
      const line = lines[i];
      if (/^\s*$/.test(line)) { flush(); i++; continue; }
      // Fenced code.
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})\s*([\w+-]*)/);
      if (fence) {
        flush();
        const body = [];
        i++;
        while (i < lines.length && !lines[i].trimStart().startsWith(fence[1])) body.push(lines[i++]);
        i++;
        out += `<pre class="md-code"><code${fence[2] ? ` data-lang="${esc(fence[2])}"` : ''}>${esc(body.join('\n'))}</code></pre>\n`;
        continue;
      }
      // Indented code (not inside a paragraph).
      if (!para.length && /^( {4}|\t)/.test(line)) {
        const body = [];
        while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || /^\s*$/.test(lines[i]))) body.push(lines[i++].replace(/^( {4}|\t)/, ''));
        while (body.length && !body[body.length - 1].trim()) body.pop();
        out += `<pre class="md-code"><code>${esc(body.join('\n'))}</code></pre>\n`;
        continue;
      }
      const h = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (h) { flush(); out += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>\n`; i++; continue; }
      // Setext headings: a paragraph line underlined with === or ---.
      if (para.length === 1 && /^ {0,3}(=+|-+) *$/.test(line)) {
        const level = line.trim()[0] === '=' ? 1 : 2;
        out += `<h${level}>${inline(para.pop())}</h${level}>\n`;
        i++;
        continue;
      }
      if (isRule(line)) { flush(); out += '<hr>\n'; i++; continue; }
      if (/^ {0,3}>/.test(line)) {
        flush();
        const body = [];
        while (i < lines.length && !/^\s*$/.test(lines[i]) && (/^ {0,3}>/.test(lines[i]) || body.length)) {
          if (!/^ {0,3}>/.test(lines[i]) && (listItem(lines[i]) || isRule(lines[i]))) break;
          body.push(lines[i++].replace(/^ {0,3}> ?/, ''));
        }
        out += `<blockquote>${blocks(body)}</blockquote>\n`;
        continue;
      }
      // Tables: a header row, a separator row, then rows.
      if (line.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        flush();
        const align = cells(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c.startsWith(':') ? 'left' : ''));
        const row = (l, tag) => '<tr>' + cells(l).map((c, k) => `<${tag}${align[k] ? ` class="al-${align[k]}"` : ''}>${inline(c)}</${tag}>`).join('') + '</tr>';
        let t = `<table><thead>${row(line, 'th')}</thead><tbody>`;
        i += 2;
        while (i < lines.length && lines[i].includes('|') && !/^\s*$/.test(lines[i])) t += row(lines[i++], 'td');
        out += t + '</tbody></table>\n';
        continue;
      }
      const item = listItem(line);
      if (item && (!para.length || item[4])) {
        flush();
        const indent = item[1].length;
        const ordered = /\d/.test(item[2]);
        const start = ordered ? parseInt(item[2], 10) : 1;
        let html = '';
        while (i < lines.length) {
          const m = listItem(lines[i]);
          if (!m || m[1].length !== indent || /\d/.test(m[2]) !== ordered) break;
          const body = [m[4]];
          const inner = m[1].length + m[2].length + Math.max(1, m[3].length);
          i++;
          while (i < lines.length) {
            const l = lines[i];
            if (/^\s*$/.test(l)) {
              const next = lines[i + 1];
              if (next !== undefined && /^\s+/.test(next) && next.search(/\S/) >= inner) { body.push(''); i++; continue; }
              break;
            }
            const sub = listItem(l);
            if (sub && sub[1].length <= indent) break;
            if (!sub && l.search(/\S/) < inner && (isRule(l) || /^ {0,3}(#|>|```)/.test(l))) break;
            body.push(l.slice(Math.min(inner, l.search(/\S/))));
            i++;
          }
          let content = body.join('\n');
          let check = '';
          const task = content.match(/^\[([ xX])\]\s+/);
          if (task) {
            check = `<input type="checkbox" disabled${task[1] !== ' ' ? ' checked' : ''}> `;
            content = content.slice(task[0].length);
          }
          const inner_html = body.length > 1 ? blocks(content.split('\n')) : inline(content);
          html += `<li${task ? ' class="task"' : ''}>${check}${inner_html}</li>`;
          while (i < lines.length && /^\s*$/.test(lines[i]) && listItem(lines[i + 1] || '') && listItem(lines[i + 1])[1].length === indent) i++;
        }
        out += ordered ? `<ol${start !== 1 ? ` start="${start}"` : ''}>${html}</ol>\n` : `<ul>${html}</ul>\n`;
        continue;
      }
      para.push(line);
      i++;
    }
    flush();
    return out;
  }

  return { render: text => blocks(text.replace(/\r\n?/g, '\n').split('\n')) };
})();

if (typeof module !== 'undefined') module.exports = MD;
