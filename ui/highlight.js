// Lightweight regex tokenizer. Produces [[class, text], ...] where class '' is plain text.
// Token classes: c comment, s string, n number, k keyword, l literal, t type, f function,
// a attribute/key, g tag, d decorator/meta, h heading, q quote, m marker, b strong, e emphasis,
// u link, x inline code.
'use strict';

const HL = (() => {
  const words = s => new Set(s.split(/\s+/).filter(Boolean));

  const C_LIKE_LIT = 'true false null nullptr NULL undefined NaN Infinity this self super';

  const LANGS = {
    text:     { name: 'Plain text', ext: ['txt', 'text', 'log', ''], prose: true },
    markdown: { name: 'Markdown', ext: ['md', 'markdown', 'mdown', 'mkd'], prose: true },
    js: {
      name: 'JavaScript', ext: ['js', 'mjs', 'cjs', 'jsx'], line: '//', block: ['/*', '*/'], str: ['"', "'", '`'],
      kw: 'break case catch class const continue debugger default delete do else export extends finally for from function get if import in instanceof let new of return set static switch throw try typeof var void while with yield async await as',
    },
    ts: {
      name: 'TypeScript', ext: ['ts', 'tsx', 'mts', 'cts'], line: '//', block: ['/*', '*/'], str: ['"', "'", '`'],
      kw: 'break case catch class const continue debugger default delete do else enum export extends finally for from function get if implements import in instanceof interface let new of return set static switch throw try typeof var void while with yield async await as type namespace declare readonly private protected public abstract keyof infer is satisfies',
      types: 'string number boolean any unknown never void object symbol bigint',
    },
    py: {
      name: 'Python', ext: ['py', 'pyw', 'pyi'], line: '#', str: ['"""', "'''", '"', "'"], deco: true,
      kw: 'and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield match case',
      lit: 'True False None self cls',
      types: 'int float str bool list dict set tuple bytes object type',
    },
    sh: {
      name: 'Shell', ext: ['sh', 'bash', 'zsh', 'fish', 'bashrc', 'zshrc', 'profile'], line: '#', str: ['"', "'"], vars: true,
      kw: 'if then else elif fi case esac for while until do done in function select return exit break continue local export readonly declare unset source alias echo printf cd set shift trap eval exec',
      lit: 'true false',
    },
    c: {
      name: 'C / C++', ext: ['c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'ino'], line: '//', block: ['/*', '*/'], str: ['"', "'"], pre: true,
      kw: 'auto break case catch class const constexpr continue default delete do else enum explicit extern for friend goto if inline namespace new noexcept operator private protected public register return sizeof static struct switch template throw try typedef typename union using virtual volatile while',
      types: 'int char float double long short signed unsigned void bool size_t uint8_t uint16_t uint32_t uint64_t int8_t int16_t int32_t int64_t std string vector',
    },
    java: {
      name: 'Java / Kotlin / C#', ext: ['java', 'kt', 'kts', 'cs', 'scala', 'groovy', 'gradle', 'dart'], line: '//', block: ['/*', '*/'], str: ['"', "'"], deco: true,
      kw: 'abstract assert break case catch class const continue default do else enum extends final finally for goto if implements import instanceof interface native new package private protected public return static strictfp super switch synchronized throw throws transient try volatile while fun val var when object companion data sealed override open internal using namespace async await readonly get set yield is as in out',
      types: 'int long short byte char float double boolean void String Object Integer List Map',
    },
    go: {
      name: 'Go', ext: ['go'], line: '//', block: ['/*', '*/'], str: ['"', "'", '`'],
      kw: 'break case chan const continue default defer else fallthrough for func go goto if import interface map package range return select struct switch type var',
      lit: 'true false nil iota',
      types: 'int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any',
    },
    rust: {
      name: 'Rust', ext: ['rs'], line: '//', block: ['/*', '*/'], str: ['"'], deco: false,
      kw: 'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut pub ref return static struct super trait type unsafe use where while',
      lit: 'true false self Self None Some Ok Err',
      types: 'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box',
    },
    php: {
      name: 'PHP', ext: ['php'], line: '//', block: ['/*', '*/'], str: ['"', "'"], vars: true,
      kw: 'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile extends final finally fn for foreach function global goto if implements include instanceof insteadof interface isset list match namespace new or print private protected public readonly require return static switch throw trait try unset use var while yield',
    },
    ruby: {
      name: 'Ruby', ext: ['rb', 'rake', 'gemspec'], line: '#', str: ['"', "'"],
      kw: 'alias and begin break case class def defined do else elsif end ensure for if in module next not or redo rescue retry return super then undef unless until when while yield require attr_accessor attr_reader puts',
      lit: 'true false nil self',
    },
    lua: {
      name: 'Lua', ext: ['lua'], line: '--', str: ['"', "'"],
      kw: 'and break do else elseif end for function goto if in local not or repeat return then until while',
      lit: 'true false nil',
    },
    sql: {
      name: 'SQL', ext: ['sql'], line: '--', block: ['/*', '*/'], str: ["'", '"'], ci: true,
      kw: 'select from where and or not insert into values update set delete create table drop alter add column index primary key foreign references join left right inner outer full on as group by order having limit offset distinct union all case when then else end is in like between exists view begin commit rollback transaction default unique with returning asc desc',
      lit: 'null true false',
      types: 'int integer bigint smallint text varchar char boolean date timestamp float real numeric serial json jsonb',
    },
    css: { name: 'CSS', ext: ['css', 'scss', 'sass', 'less'], css: true },
    html: { name: 'HTML / XML', ext: ['html', 'htm', 'xhtml', 'xml', 'svg', 'vue', 'svelte', 'plist', 'xaml'], markup: true },
    json: { name: 'JSON', ext: ['json', 'jsonc', 'json5', 'webmanifest', 'lock'], json: true },
    conf: { name: 'Config (YAML/TOML/INI)', ext: ['yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'desktop', 'service', 'gitconfig', 'editorconfig'], conf: true },
  };

  for (const l of Object.values(LANGS)) {
    l.kwSet = words(l.ci ? (l.kw || '').toLowerCase() : (l.kw || ''));
    l.litSet = words(l.lit || C_LIKE_LIT);
    l.typeSet = words(l.types || '');
  }

  const SPECIAL_NAMES = { makefile: 'sh', dockerfile: 'sh', 'cmakelists.txt': 'sh', '.bashrc': 'sh', '.zshrc': 'sh', '.profile': 'sh', '.gitignore': 'conf', '.env': 'conf' };

  function detect(path) {
    if (!path) return 'text';
    const base = path.split('/').pop().toLowerCase();
    if (SPECIAL_NAMES[base]) return SPECIAL_NAMES[base];
    const dot = base.lastIndexOf('.');
    const ext = dot > 0 ? base.slice(dot + 1) : (base.startsWith('.') ? base.slice(1) : '');
    for (const [id, l] of Object.entries(LANGS)) if (ext && l.ext.includes(ext)) return id;
    return 'text';
  }

  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function strPattern(d) {
    if (d.length === 3) return `${esc(d)}[\\s\\S]*?(?:${esc(d)}|(?![\\s\\S]))`;
    if (d === '`') return '`(?:\\\\[\\s\\S]|[^`\\\\])*`?';
    return `${esc(d)}(?:\\\\.|[^${esc(d)}\\\\\\n])*${esc(d)}?`;
  }

  const reCache = {};
  function codeRegex(id, l) {
    if (reCache[id]) return reCache[id];
    const parts = [];
    const cm = [];
    if (l.block) cm.push(`${esc(l.block[0])}[\\s\\S]*?(?:${esc(l.block[1])}|(?![\\s\\S]))`);
    if (l.line) cm.push(`${esc(l.line)}[^\\n]*`);
    if (l.pre) cm.push('^[ \\t]*#[^\\n]*');
    parts.push(`(${cm.join('|') || '(?!)'})`);                                  // 1 comment
    parts.push(`(${(l.str || []).map(strPattern).join('|') || '(?!)'})`);      // 2 string
    parts.push('(\\b(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|\\d[\\d_]*(?:\\.\\d[\\d_]*)?(?:[eE][+-]?\\d+)?)[a-zA-Z]*\\b)'); // 3 number
    parts.push(l.deco ? '(@[\\w.]+)' : '((?!))');                              // 4 decorator
    parts.push(l.vars ? '(\\$\\{?[\\w@#?*!-]+\\}?)' : '((?!))');               // 5 variable
    parts.push('([A-Za-z_$][\\w$]*)');                                          // 6 word
    return (reCache[id] = new RegExp(parts.join('|'), 'gm'));
  }

  function tokenizeCode(text, id, l) {
    const re = codeRegex(id, l);
    const out = [];
    let last = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m.index > last) out.push(['', text.slice(last, m.index)]);
      let cls = '';
      if (m[1]) cls = 'c';
      else if (m[2]) cls = 's';
      else if (m[3]) cls = 'n';
      else if (m[4]) cls = 'd';
      else if (m[5]) cls = 'a';
      else {
        const w = m[6], lw = l.ci ? w.toLowerCase() : w;
        if (l.kwSet.has(lw)) cls = 'k';
        else if (l.litSet.has(lw)) cls = 'l';
        else if (l.typeSet.has(lw)) cls = 't';
        else if (/^\s*\(/.test(text.slice(re.lastIndex, re.lastIndex + 40))) cls = 'f';
        else if (/^[A-Z][a-z0-9]/.test(w)) cls = 't';
      }
      out.push([cls, m[0]]);
      last = re.lastIndex;
    }
    if (last < text.length) out.push(['', text.slice(last)]);
    return out;
  }

  // rules: [[cls, source], ...] — sources must use only non-capturing groups.
  const listCache = new Map();
  function tokenizeRegexList(text, rules) {
    let re = listCache.get(rules);
    if (!re) listCache.set(rules, re = new RegExp(rules.map(r => `(${r[1]})`).join('|'), 'gm'));
    re.lastIndex = 0;
    const out = [];
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m[0] === '') { re.lastIndex++; continue; }
      if (m.index > last) out.push(['', text.slice(last, m.index)]);
      let g = 1;
      while (m[g] === undefined) g++;
      out.push([rules[g - 1][0], m[0]]);
      last = re.lastIndex;
    }
    if (last < text.length) out.push(['', text.slice(last)]);
    return out;
  }

  const CSS_RULES = [
    ['c', '\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))'],
    ['c', '^\\s*\\/\\/[^\\n]*'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'(?:\\\\.|[^\'\\\\\\n])*\'?'],
    ['k', '@[\\w-]+|!important'],
    ['n', '#[\\da-fA-F]{3,8}\\b|-?\\b\\d*\\.?\\d+(?:px|em|rem|%|vh|vw|ch|s|ms|deg|fr|pt)?\\b'],
    ['a', '--[\\w-]+|[\\w-]+(?=\\s*:[^:{};]*[;}\\n])'],
    ['f', '[\\w-]+(?=\\()'],
    ['g', '[.#][\\w-]+|::?[\\w-]+'],
  ];

  const JSON_RULES = [
    ['c', '\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|(?![\\s\\S]))'],
    ['a', '"(?:\\\\.|[^"\\\\\\n])*"(?=\\s*:)'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?'],
    ['n', '-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b'],
    ['l', '\\b(?:true|false|null)\\b'],
  ];

  const CONF_RULES = [
    ['c', '^\\s*[#;][^\\n]*|\\s#[^\\n]*'],
    ['h', '^\\s*\\[[^\\]\\n]*\\]'],
    ['a', '^\\s*-?\\s*[\\w.$@/"\'-]+(?=\\s*[:=])'],
    ['s', '"(?:\\\\.|[^"\\\\\\n])*"?|\'[^\'\\n]*\'?'],
    ['l', '\\b(?:true|false|yes|no|on|off|null)\\b'],
    ['n', '-?\\b\\d+(?:\\.\\d+)?\\b'],
    ['m', '^\\s*-(?=\\s)|^---$'],
  ];

  function tokenizeMarkup(text) {
    const out = [];
    const re = /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<(?:[!?/]?[A-Za-z][\w:.-]*|[!?])|&[#\w]+;/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) out.push(['', text.slice(last, m.index)]);
      const tok = m[0];
      if (tok.startsWith('<!--') || tok.startsWith('<![')) { out.push(['c', tok]); last = re.lastIndex; continue; }
      if (tok[0] === '&') { out.push(['n', tok]); last = re.lastIndex; continue; }
      out.push(['g', tok]);
      // inside tag: attributes until '>'
      const inner = /\s+|[\w:.@#-]+|=|"[^"]*"?|'[^']*'?|\/?>|[^]/g;
      let pos = inner.lastIndex = re.lastIndex, n;
      while ((n = inner.exec(text))) {
        const s = n[0];
        if (s === '<') break;
        pos = inner.lastIndex;
        if (s === '>' || s === '/>') { out.push(['g', s]); break; }
        if (s[0] === '"' || s[0] === "'") out.push(['s', s]);
        else if (/^[\w:.@#-]+$/.test(s)) out.push(['a', s]);
        else out.push(['', s]);
      }
      last = re.lastIndex = pos;
      if (tok === '<style' || tok === '<script') {
        const close = text.indexOf(tok === '<style' ? '</style' : '</script', last);
        const end = close < 0 ? text.length : close;
        if (end > last) out.push(...tokenize(text.slice(last, end), tok === '<style' ? 'css' : 'js'));
        last = re.lastIndex = end;
      }
    }
    if (last < text.length) out.push(['', text.slice(last)]);
    return out;
  }

  function tokenizeInlineMd(line, out) {
    const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|((?:^|(?<=\s))[*_][^*_\s][^*_\n]*[*_](?=\W|$))|(!?\[[^\]\n]*\]\([^)\n]*\))|(<?https?:\/\/[^\s>)]+>?)/g;
    let last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) out.push(['', line.slice(last, m.index)]);
      if (m[1]) out.push(['x', m[1]]);
      else if (m[2]) out.push(['b', m[2]]);
      else if (m[3]) out.push(['e', m[3]]);
      else if (m[4]) {
        const i = m[4].indexOf('](');
        out.push(['u', m[4].slice(0, i + 1)], ['m', m[4].slice(i + 1)]);
      } else out.push(['u', m[5]]);
      last = re.lastIndex;
    }
    if (last < line.length) out.push(['', line.slice(last)]);
  }

  function tokenizeMarkdown(text) {
    const out = [];
    const lines = text.split('\n');
    let fence = null;
    lines.forEach((line, i) => {
      const nl = i < lines.length - 1 ? '\n' : '';
      const f = line.match(/^\s*(```|~~~)/);
      if (fence) {
        out.push(['x', line + nl]);
        if (f && f[1] === fence) fence = null;
        return;
      }
      if (f) { fence = f[1]; out.push(['x', line + nl]); return; }
      let m;
      if ((m = line.match(/^(#{1,6}\s)(.*)$/))) { out.push(['m', m[1]], ['h', m[2] + nl]); return; }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push(['m', line + nl]); return; }
      if ((m = line.match(/^(\s*>+\s?)(.*)$/))) { out.push(['m', m[1]]); const q = []; tokenizeInlineMd(m[2], q); q.forEach(t => out.push([t[0] || 'q', t[1]])); out.push(['', nl]); return; }
      if ((m = line.match(/^(\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?)(.*)$/))) { out.push(['m', m[1]]); line = m[2]; }
      tokenizeInlineMd(line, out);
      out.push(['', nl]);
    });
    return out;
  }

  function tokenize(text, id) {
    const l = LANGS[id] || LANGS.text;
    if (id === 'text' || !l) return [['', text]];
    if (id === 'markdown') return tokenizeMarkdown(text);
    if (l.markup) return tokenizeMarkup(text);
    if (l.css) return tokenizeRegexList(text, CSS_RULES);
    if (l.json) return tokenizeRegexList(text, JSON_RULES);
    if (l.conf) return tokenizeRegexList(text, CONF_RULES);
    return tokenizeCode(text, id, l);
  }

  const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // Render tokens to HTML, overlaying search matches ([[start, end], ...], sorted) as <mark>.
  function render(tokens, matches, cur) {
    let html = '';
    if (!matches || !matches.length) {
      for (const [c, t] of tokens) html += c ? `<span class="t${c}">${escHtml(t)}</span>` : escHtml(t);
      return html;
    }
    let pos = 0, mi = 0;
    for (const [c, t] of tokens) {
      let i = 0;
      while (i < t.length) {
        while (mi < matches.length && matches[mi][1] <= pos + i) mi++;
        const m = matches[mi];
        let end = t.length, inMatch = false;
        if (m) {
          if (m[0] <= pos + i) { inMatch = true; end = Math.min(t.length, m[1] - pos); }
          else end = Math.min(t.length, m[0] - pos);
        }
        const piece = escHtml(t.slice(i, end));
        const span = c ? `<span class="t${c}">${piece}</span>` : piece;
        html += inMatch ? `<mark${mi === cur ? ' class="cur"' : ''}>${span}</mark>` : span;
        i = end;
      }
      pos += t.length;
    }
    return html;
  }

  const isCode = id => !!LANGS[id] && !LANGS[id].prose;

  return { LANGS, detect, tokenize, render, isCode };
})();
