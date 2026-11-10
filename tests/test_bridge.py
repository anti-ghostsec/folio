"""The page may only reach files it was handed a token for.

Run from the repository root:  python3 -m unittest discover -s tests
"""
import os
import re
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

try:
    import gi
    gi.require_version('Gtk', '4.0')
    gi.require_version('WebKit', '6.0')
    HAVE_GTK = True
except (ImportError, ValueError):
    # No GTK here (a build machine): the file handling is plain Python and
    # is tested all the same, with empty stand-ins for the toolkit.
    HAVE_GTK = False

    class _Namespace(type):
        """Stands in for Gtk, Gdk, ...: any name in it is an empty class."""
        def __getattr__(cls, name):
            if name.startswith('__'):
                raise AttributeError(name)
            value = type(name, (), {})
            setattr(cls, name, value)
            return value

    gi = types.ModuleType('gi')
    gi.require_version = lambda *a: None
    gi.repository = types.ModuleType('gi.repository')
    for _name in ('Gdk', 'Gio', 'GLib', 'Gtk', 'WebKit'):
        setattr(gi.repository, _name, _Namespace(_name, (), {}))
    gi.repository.GLib.get_user_config_dir = staticmethod(tempfile.gettempdir)
    sys.modules['gi'] = gi
    sys.modules['gi.repository'] = gi.repository

import folio  # noqa: E402


def window():
    """Just enough of the window for the bridge commands to run."""
    w = types.SimpleNamespace(docs=folio.Documents(), text_args=folio.FolioWindow.text_args)
    w.save_as = lambda *a: folio.FolioWindow.save_as(w, *a)
    return w


class BridgeTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.opened = self.dir / 'opened.txt'
        self.opened.write_text('opened\n')
        self.other = self.dir / 'other.txt'
        self.other.write_text('private\n')
        self.w = window()

    def cmd(self, name, **args):
        return getattr(folio.FolioWindow, 'cmd_' + name)(self.w, args, None)

    # ---- writing ----

    def test_save_to_a_path_is_refused(self):
        r = self.cmd('save', path=str(self.other), content='overwritten')
        self.assertIn('error', r)
        self.assertEqual(self.other.read_text(), 'private\n')

    def test_a_path_is_not_a_token(self):
        self.w.docs.open(str(self.opened))
        for guess in (str(self.other), str(self.opened), '', None, 0, ['x'], {'a': 1}):
            r = self.cmd('save', doc=guess, content='overwritten')
            self.assertIn('error', r, guess)
        self.assertEqual(self.other.read_text(), 'private\n')
        self.assertEqual(self.opened.read_text(), 'opened\n')

    def test_save_new_file_needs_the_dialog(self):
        target = self.dir / 'new.txt'
        self.assertIn('error', self.cmd('save', path=str(target), doc=str(target), content='x'))
        self.assertFalse(target.exists())

    def test_save_writes_the_opened_document(self):
        f = self.w.docs.open(str(self.opened))
        r = self.cmd('save', doc=f['doc'], content='changed\n')
        self.assertNotIn('error', r)
        self.assertEqual(self.opened.read_text(), 'changed\n')
        self.assertEqual(self.other.read_text(), 'private\n')

    def test_save_ignores_a_path_sent_with_the_token(self):
        f = self.w.docs.open(str(self.opened))
        self.cmd('save', doc=f['doc'], path=str(self.other), content='changed\n')
        self.assertEqual(self.opened.read_text(), 'changed\n')
        self.assertEqual(self.other.read_text(), 'private\n')

    def test_save_keeps_line_endings_and_mode(self):
        self.opened.write_bytes(b'a\r\nb\r\n')
        os.chmod(self.opened, 0o640)
        f = self.w.docs.open(str(self.opened))
        self.assertEqual(f['eol'], '\r\n')
        self.cmd('save', doc=f['doc'], content='a\nb\nc\n', eol=f['eol'], encoding=f['encoding'])
        self.assertEqual(self.opened.read_bytes(), b'a\r\nb\r\nc\r\n')
        self.assertEqual(stat.S_IMODE(self.opened.stat().st_mode), 0o640)

    def test_save_as_result_can_be_saved_again(self):
        target = self.dir / 'copy.txt'
        r = self.w.save_as(str(target), 'one\n', '\n', 'utf-8')
        self.assertEqual(r['path'], str(target))
        self.assertNotIn('error', self.cmd('save', doc=r['doc'], content='two\n'))
        self.assertEqual(target.read_text(), 'two\n')

    def test_closed_document_can_no_longer_be_written(self):
        f = self.w.docs.open(str(self.opened))
        self.cmd('close', doc=f['doc'])
        self.assertIn('error', self.cmd('save', doc=f['doc'], content='late'))
        self.assertEqual(self.opened.read_text(), 'opened\n')

    def test_each_opening_has_its_own_token(self):
        a = self.w.docs.open(str(self.opened))
        b = self.w.docs.open(str(self.opened))
        self.assertNotEqual(a['doc'], b['doc'])
        self.cmd('close', doc=b['doc'])
        self.assertNotIn('error', self.cmd('save', doc=a['doc'], content='still open\n'))

    # ---- reading ----

    def test_there_is_no_read_by_path(self):
        self.assertFalse(hasattr(folio.FolioWindow, 'cmd_read'))

    def test_reload_by_path_is_refused(self):
        for args in ({'path': str(self.other)}, {'paths': [str(self.other)]}, {'doc': str(self.other)}):
            r = self.cmd('reload', **args)
            self.assertIn('error', r)
            self.assertNotIn('content', r)

    def test_reload_reads_the_opened_document(self):
        f = self.w.docs.open(str(self.opened))
        self.opened.write_text('changed outside\n')
        self.assertEqual(self.cmd('reload', doc=f['doc'])['content'], 'changed outside\n')

    def test_stat_tells_nothing_about_other_files(self):
        f = self.w.docs.open(str(self.opened))
        r = self.cmd('stat', docs=[f['doc'], str(self.other), None, 7], paths=[str(self.other)])
        self.assertEqual(list(r), [f['doc']])
        self.assertIsInstance(r[f['doc']], int)

    def test_a_file_that_cannot_be_read_gets_no_token(self):
        f = self.w.docs.open(str(self.dir / 'missing.txt'))
        self.assertIn('error', f)
        self.assertNotIn('doc', f)
        self.assertEqual(self.w.docs.paths, {})

    def test_command_line_files_get_tokens(self):
        self.w.pending_files = [str(self.opened)]
        self.w.settings = {'theme': 'ink', '_window': {'w': 1}}
        r = self.cmd('init')
        self.assertEqual(r['files'][0]['content'], 'opened\n')
        self.assertEqual(self.w.docs.path(r['files'][0]['doc']), str(self.opened))
        self.assertEqual(r['settings'], {'theme': 'ink'})

    # ---- everything else the page can send ----

    def test_only_expected_commands_exist(self):
        cmds = sorted(n[4:] for n in dir(folio.FolioWindow) if n.startswith('cmd_'))
        self.assertEqual(cmds, ['close', 'fullscreen', 'init', 'open', 'quit', 'reload', 'save', 'saveAs',
                                'saveSettings', 'setTheme', 'setTitle', 'stat'])

    def test_settings_are_plain_values(self):
        got = folio.clean_settings({'theme': 'ink', 'fontSize': 19, 'fade': True, 'lineHeight': 1.7,
                                    '_window': {'w': 1}, 'nested': {'a': 1}, 'list': [1],
                                    'long': 'x' * 5000, 3: 'x'})
        self.assertEqual(got, {'theme': 'ink', 'fontSize': 19, 'fade': True, 'lineHeight': 1.7})
        self.assertEqual(folio.clean_settings('nope'), {})

    @unittest.skipUnless(HAVE_GTK, 'needs GTK')
    def test_theme_colours_cannot_carry_css(self):
        self.assertEqual(folio.css_colour('#102030', '#000'), 'rgb(16,32,48)')
        bad = 'red; } window { background: url("file:///etc/passwd"); '
        self.assertEqual(folio.css_colour(bad, '#000'), '#000')
        self.assertEqual(folio.css_colour(None, '#000'), '#000')


class PageTest(unittest.TestCase):
    """The page's side: it sends tokens, and loads nothing but its own files."""

    def setUp(self):
        self.app = (ROOT / 'ui' / 'app.js').read_text(encoding='utf-8')
        self.html = (ROOT / 'ui' / 'index.html').read_text(encoding='utf-8')

    def test_page_sends_no_paths(self):
        for m in re.finditer(r"\bcall\('(\w+)',\s*\{([^}]*)\}", self.app):
            keys = re.findall(r'(\w+)\s*(?::|,|$)', m.group(2))
            for key in ('path', 'paths', 'dir'):
                self.assertNotIn(key, keys, m.group(0))
        self.assertNotIn("call('read'", self.app)

    def test_policy_is_strict(self):
        m = re.search(r'<meta http-equiv="Content-Security-Policy" content="([^"]*)">', self.html)
        self.assertTrue(m, 'no content security policy')
        policy = dict(p.strip().split(' ', 1) for p in m.group(1).split(';') if p.strip())
        self.assertEqual(policy['default-src'], "'none'")
        for src in ('script-src', 'style-src', 'font-src'):
            self.assertEqual(policy[src], "'self'")
        for word in ('unsafe', 'http', '*', 'data:', 'blob:'):
            self.assertNotIn(word, m.group(1))
        # It has to come before anything the page loads.
        self.assertLess(m.start(), self.html.index('<link'))

    def test_nothing_inline_or_remote(self):
        self.assertNotRegex(self.html, r'<script(?![^>]*\bsrc=)')
        self.assertNotRegex(self.html, r'<style\b')
        self.assertNotRegex(self.html, r'\sstyle\s*=')
        self.assertNotRegex(self.html, r'\son\w+\s*=')
        self.assertNotRegex(self.html, r'(src|href)="(https?:)?//')
        for name in ('app.js', 'markdown.js', 'highlight.js'):
            js = (ROOT / 'ui' / name).read_text(encoding='utf-8')
            self.assertNotRegex(js, r'[\s"\'`]style\s*=\s*["\'\\$]', name)
            self.assertNotRegex(js, r'\beval\(|new Function\(', name)


class ReleaseTest(unittest.TestCase):
    def setUp(self):
        self.yml = (ROOT / '.github' / 'workflows' / 'release.yml').read_text(encoding='utf-8')

    def test_actions_are_pinned_to_commits(self):
        uses = re.findall(r'^\s*-?\s*uses:\s*(\S+)', self.yml, re.M)
        self.assertTrue(uses)
        for u in uses:
            self.assertRegex(u, r'@[0-9a-f]{40}$', u)

    def test_signing_only_from_main(self):
        job = self.yml[self.yml.index('\njobs:'):self.yml.index('\n    steps:')]
        self.assertIn("\n    if: github.ref == 'refs/heads/main'\n", job)
        self.assertIn('\n    environment: release\n', job)


if __name__ == '__main__':
    unittest.main()
