#!/usr/bin/env python3
"""Folio — a calm text editor for writing (and a bit of code).

GTK 4 window hosting a WebKit view; the editor UI lives in ui/.
Usage: folio.py [FILE ...]
"""
import json
import os
import secrets
import sys
import tempfile
from pathlib import Path

import gi

gi.require_version('Gtk', '4.0')
gi.require_version('Gdk', '4.0')
gi.require_version('WebKit', '6.0')
from gi.repository import Gdk, Gio, GLib, Gtk, WebKit  # noqa: E402

APP_ID = 'app.folio.Editor'
APP_DIR = Path(__file__).resolve().parent
UI_INDEX = APP_DIR / 'ui' / 'index.html'
# Privacy: settings are the only thing Folio writes on its own. Open files, unsaved
# notes and history live in memory and are gone when the window closes.
CONFIG_DIR = Path(GLib.get_user_config_dir()) / 'folio'
SETTINGS_FILE = CONFIG_DIR / 'settings.json'
LEGACY_SESSION_FILE = CONFIG_DIR / 'session.json'
MAX_BYTES = 50 * 1024 * 1024

THEME_BG = {'night': '#1d1e22', 'ink': '#0f1218', 'paper': '#fbfaf7', 'sepia': '#f5edda'}


def load_json(path, default):
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError):
        return default


def write_atomic(path, data: bytes, mode=None):
    path = Path(os.path.realpath(path))
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix='.' + path.name + '.', suffix='.tmp')
    try:
        with os.fdopen(fd, 'wb') as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        if mode is not None:
            os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    write_atomic(path, json.dumps(obj, ensure_ascii=False, indent=1).encode('utf-8'))


def remove_legacy_session():
    """Older versions kept a list of open tabs; delete it and any half-written copies."""
    for f in [LEGACY_SESSION_FILE, *CONFIG_DIR.glob('.session.json.*.tmp')]:
        try:
            f.unlink()
        except OSError:
            pass


def mtime(path):
    try:
        return os.stat(path).st_mtime_ns // 1_000_000
    except OSError:
        return None


def read_file(path):
    path = os.path.abspath(os.path.expanduser(path))
    name = os.path.basename(path)
    try:
        if os.path.getsize(path) > MAX_BYTES:
            return {'path': path, 'error': f'{name} is too large to open (over 50 MB)'}
        data = Path(path).read_bytes()
    except FileNotFoundError:
        return {'path': path, 'error': f'{name} not found'}
    except IsADirectoryError:
        return {'path': path, 'error': f'{name} is a folder'}
    except OSError as e:
        return {'path': path, 'error': f'Could not open {name}: {e.strerror}'}
    if b'\0' in data[:8192]:
        return {'path': path, 'error': f'{name} looks like a binary file'}
    encoding = 'utf-8'
    if data.startswith(b'\xef\xbb\xbf'):
        encoding, data = 'utf-8-sig', data[3:]
    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        encoding = 'latin-1'
        text = data.decode('latin-1')
    eol = '\r\n' if '\r\n' in text else '\n'
    text = text.replace('\r\n', '\n')
    return {'path': path, 'content': text, 'eol': eol, 'encoding': encoding, 'mtime': mtime(path)}


def write_file(path, content, eol='\n', encoding='utf-8'):
    try:
        if eol == '\r\n':
            content = content.replace('\n', '\r\n')
        try:
            data = content.encode(encoding)
        except (UnicodeEncodeError, LookupError):
            data = content.encode('utf-8')
        mode = None
        try:
            mode = os.stat(os.path.realpath(path)).st_mode & 0o7777
        except FileNotFoundError:
            pass
        write_atomic(path, data, mode)
        return {'path': path, 'name': os.path.basename(path), 'mtime': mtime(path)}
    except OSError as e:
        return {'error': f'Could not save {os.path.basename(path)}: {e.strerror}'}


class Documents:
    """The files the page may read and write, by token.

    The page never names a path. A file gets a token when it is opened by a
    route the page has no say in (the command line or "Open with", a file
    dialog, a drop from the file manager), and the page asks for "the document
    with this token" from then on. Kept in memory only.
    """

    def __init__(self):
        self.paths = {}

    def add(self, path):
        token = secrets.token_urlsafe(16)
        self.paths[token] = os.path.abspath(path)
        return token

    def path(self, token):
        """The path behind a token, or None if the page made it up."""
        return self.paths.get(token) if isinstance(token, str) else None

    def forget(self, token):
        if isinstance(token, str):
            self.paths.pop(token, None)

    def open(self, path):
        """Read a file for the page; it gets a token only if it could be read."""
        f = read_file(path)
        if 'error' not in f:
            f['doc'] = self.add(f['path'])
        return f


def clean_settings(settings):
    """What the page may store: plain named values, nothing nested or huge."""
    if not isinstance(settings, dict):
        return {}
    out = {}
    for k, v in list(settings.items())[:64]:
        if not isinstance(k, str) or not k or k.startswith('_') or len(k) > 40:
            continue
        if isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= 200):
            out[k] = v
    return out


def css_colour(value, fallback):
    """A colour from the page, as GTK writes it; anything else gives the fallback."""
    color = Gdk.RGBA()
    if isinstance(value, str) and color.parse(value):
        return color.to_string()
    return fallback


class FolioWindow(Gtk.ApplicationWindow):
    def __init__(self, app, files):
        super().__init__(application=app, title='Folio')
        self.app = app
        self.ready = False
        self.allow_close = False
        self.pending_files = list(files)
        self.docs = Documents()
        self.settings = load_json(SETTINGS_FILE, {})

        state = self.settings.get('_window', {})
        self.set_default_size(state.get('w', 1000), state.get('h', 760))
        if state.get('max'):
            self.maximize()
        self.set_icon_name('folio')

        # No custom titlebar: the window manager's own decorations show the title.
        self.css = Gtk.CssProvider()
        Gtk.StyleContext.add_provider_for_display(
            Gdk.Display.get_default(), self.css, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION + 1)
        self.dark = None
        theme = self.settings.get('theme', 'night')
        dark = theme in ('night', 'ink')
        bg = THEME_BG.get(theme, THEME_BG['night'])
        self.apply_theme({'bg': bg, 'fg': '#dcd8cf' if dark else '#2a2925', 'dark': dark})

        # Web view with an ephemeral session: no cookies, caches or storage on disk.
        manager = WebKit.UserContentManager()
        manager.register_script_message_handler('folio', None)
        manager.connect('script-message-received::folio', self.on_message)
        self.web = WebKit.WebView(user_content_manager=manager,
                                  network_session=WebKit.NetworkSession.new_ephemeral())
        ws = self.web.get_settings()
        ws.set_enable_developer_extras(bool(os.environ.get('FOLIO_DEBUG')))
        ws.set_enable_back_forward_navigation_gestures(False)
        ws.set_javascript_can_access_clipboard(True)
        color = Gdk.RGBA()
        color.parse(bg)
        self.web.set_background_color(color)
        self.web.connect('decide-policy', self.on_decide_policy)
        self.web.connect('context-menu', self.on_context_menu)
        self.web.connect('web-process-terminated', lambda *a: self.web.reload())
        self.setup_spellcheck()
        self.setup_drop()
        self.web.load_uri(UI_INDEX.as_uri())
        self.set_child(self.web)

        self.connect('close-request', self.on_close_request)

    # ---------- setup ----------

    def setup_spellcheck(self):
        try:
            ctx = self.web.get_context() if hasattr(self.web, 'get_context') else WebKit.WebContext.get_default()
            langs = [l for l in GLib.get_language_names() if '_' in l and '.' not in l and '@' not in l][:2] or ['en_US']
            ctx.set_spell_checking_enabled(True)
            ctx.set_spell_checking_languages(langs)
        except Exception:
            pass

    def setup_drop(self):
        # Files dropped from the file manager are taken here, before the page
        # sees them: the page is never the one to say which path to open.
        drop = Gtk.DropTarget.new(Gdk.FileList, Gdk.DragAction.COPY)
        drop.set_propagation_phase(Gtk.PropagationPhase.CAPTURE)
        drop.connect('enter', self.on_drop_enter)
        drop.connect('leave', lambda t: self.drop_hint(False))
        drop.connect('drop', self.on_drop)
        self.web.add_controller(drop)

    def drop_hint(self, show):
        if self.ready:
            self.js(f'folio.dropHint({json.dumps(bool(show))})')

    def on_drop_enter(self, target, x, y):
        self.drop_hint(True)
        return Gdk.DragAction.COPY

    def on_drop(self, target, value, x, y):
        self.drop_hint(False)
        paths = [f.get_path() for f in value.get_files() if f.get_path()]
        if not paths:
            return False
        self.open_files(paths)
        return True

    def apply_theme(self, t):
        bg = css_colour(t.get('bg'), THEME_BG['night'])
        fg = css_colour(t.get('fg'), '#dcd8cf')
        self.css.load_from_string(f"window, window.background {{ background: {bg}; color: {fg}; }}")
        dark = bool(t.get('dark'))
        if dark != self.dark:  # flipping this restyles all of GTK, so only do it when it changes
            self.dark = dark
            Gtk.Settings.get_default().set_property('gtk-application-prefer-dark-theme', dark)

    # ---------- web view policy ----------

    def on_decide_policy(self, view, decision, kind):
        if kind == WebKit.PolicyDecisionType.NAVIGATION_ACTION:
            nav = decision.get_navigation_action()
            uri = nav.get_request().get_uri()
            if uri.split('#')[0] != UI_INDEX.as_uri():
                # Only a link the user clicked goes out, and only once they
                # say so: a note can't send the browser anywhere by itself.
                if (uri.lower().startswith(('http://', 'https://', 'mailto:')) and nav.is_user_gesture()
                        and nav.get_navigation_type() == WebKit.NavigationType.LINK_CLICKED):
                    self.confirm_link(uri)
                decision.ignore()
                return True
        elif kind == WebKit.PolicyDecisionType.NEW_WINDOW_ACTION:
            decision.ignore()
            return True
        return False

    def confirm_link(self, url):
        shown = url if len(url) <= 300 else url[:300] + '…'
        dialog = Gtk.AlertDialog(message='Open this link in your web browser?', detail=shown,
                                 buttons=['Cancel', 'Open link'], cancel_button=0, default_button=0, modal=True)

        def done(d, res):
            try:
                if d.choose_finish(res) == 1:
                    Gtk.UriLauncher.new(url).launch(self, None, None, None)
            except GLib.Error:
                pass
        dialog.choose(self, None, done)

    def on_context_menu(self, view, menu, hit):
        hide = {WebKit.ContextMenuAction.GO_BACK, WebKit.ContextMenuAction.GO_FORWARD,
                WebKit.ContextMenuAction.STOP, WebKit.ContextMenuAction.RELOAD,
                WebKit.ContextMenuAction.OPEN_LINK, WebKit.ContextMenuAction.OPEN_LINK_IN_NEW_WINDOW,
                WebKit.ContextMenuAction.DOWNLOAD_LINK_TO_DISK, WebKit.ContextMenuAction.COPY_LINK_TO_CLIPBOARD}
        if not os.environ.get('FOLIO_DEBUG'):
            hide.add(WebKit.ContextMenuAction.INSPECT_ELEMENT)
        for item in list(menu.get_items()):
            if item.get_stock_action() in hide:
                menu.remove(item)
        # Drop separators left dangling at the edges.
        items = menu.get_items()
        while items and items[0].is_separator():
            menu.remove(items[0]); items = menu.get_items()
        while items and items[-1].is_separator():
            menu.remove(items[-1]); items = menu.get_items()
        return not items

    # ---------- JS bridge ----------

    def js(self, script):
        self.web.evaluate_javascript(script, -1, None, None, None, None, None)

    def reply(self, call_id, data):
        self.js(f'folio.resolve({int(call_id)}, {json.dumps(data)})')

    def on_message(self, manager, value):
        try:
            msg = json.loads(value.to_string())
        except (ValueError, TypeError):
            return
        if not isinstance(msg, dict) or not isinstance(msg.get('id'), int):
            return
        cmd, args, cid = msg.get('cmd'), msg.get('args'), msg.get('id')
        if not isinstance(args, dict):
            args = {}
        handler = getattr(self, 'cmd_' + str(cmd), None)
        if handler is None:
            self.reply(cid, None)
            return
        try:
            result = handler(args, lambda data: self.reply(cid, data))
        except Exception as e:  # never leave a JS promise hanging
            print(f'folio: {cmd} failed: {e}', file=sys.stderr)
            self.reply(cid, {'error': str(e)})
            return
        if result is not NotImplemented:
            self.reply(cid, result)

    # Commands return a value, or NotImplemented when they will call done() later.

    # The page names documents by the token it was given, never by path.

    def cmd_init(self, args, done):
        self.ready = True
        self.docs = Documents()  # a page that starts over holds no tokens
        files = [self.docs.open(p) for p in self.pending_files]
        self.pending_files = []
        settings = {k: v for k, v in self.settings.items() if not k.startswith('_')}
        return {'settings': settings, 'files': files, 'home': str(Path.home())}

    def cmd_reload(self, args, done):
        path = self.docs.path(args.get('doc'))
        if path is None:
            return {'error': 'That document isn\'t open'}
        return read_file(path)

    def cmd_stat(self, args, done):
        docs = args.get('docs')
        docs = docs if isinstance(docs, list) else []
        return {d: mtime(self.docs.path(d)) for d in docs if self.docs.path(d) is not None}

    def cmd_save(self, args, done):
        path = self.docs.path(args.get('doc'))
        if path is None:
            return {'error': 'Could not save: that document isn\'t open'}
        return write_file(path, *self.text_args(args))

    def cmd_saveAs(self, args, done):
        # Where it goes is the user's answer to this dialog and nothing else;
        # the page only suggests a file name.
        content, eol, encoding = self.text_args(args)
        dialog = Gtk.FileDialog(title='Save As', modal=True)
        name = args.get('name')
        name = os.path.basename(name) if isinstance(name, str) else ''
        dialog.set_initial_name(name or 'Untitled.txt')
        current = self.docs.path(args.get('doc'))
        folder = os.path.dirname(current) if current else str(Path.home() / 'Documents')
        if not os.path.isdir(folder):
            folder = str(Path.home())
        dialog.set_initial_folder(Gio.File.new_for_path(folder))

        def finished(dlg, res):
            try:
                f = dlg.save_finish(res)
            except GLib.Error:
                done(None)
                return
            done(self.save_as(f.get_path(), content, eol, encoding))

        dialog.save(self, None, finished)
        return NotImplemented

    def save_as(self, path, content, eol, encoding):
        """Write to the path a Save As dialog gave, and hand the page a token for it."""
        if not path:
            return {'error': 'Could not save there'}
        r = write_file(path, content, eol, encoding)
        if 'error' not in r:
            r['doc'] = self.docs.add(r['path'])
        return r

    @staticmethod
    def text_args(args):
        content = args.get('content', '')
        eol = '\r\n' if args.get('eol') == '\r\n' else '\n'
        encoding = args.get('encoding', 'utf-8')
        return (content if isinstance(content, str) else '', eol,
                encoding if isinstance(encoding, str) else 'utf-8')

    def cmd_open(self, args, done):
        dialog = Gtk.FileDialog(title='Open', modal=True)
        current = self.docs.path(args.get('doc'))
        folder = os.path.dirname(current) if current else str(Path.home())
        if os.path.isdir(folder):
            dialog.set_initial_folder(Gio.File.new_for_path(folder))

        def finished(dlg, res):
            try:
                files = dlg.open_multiple_finish(res)
            except GLib.Error:
                done(None)
                return
            paths = [files.get_item(i).get_path() for i in range(files.get_n_items())]
            done([self.docs.open(p) for p in paths if p])

        dialog.open_multiple(self, None, finished)
        return NotImplemented

    def cmd_close(self, args, done):
        # The tab is gone, and with it the page's way to reach the file.
        self.docs.forget(args.get('doc'))
        return True

    def cmd_setTitle(self, args, done):
        title = str(args.get('title') or 'Folio')[:200]
        dirty = '• ' if args.get('dirty') else ''
        sub = str(args.get('subtitle') or '')[:400]
        self.set_title(f'{dirty}{title}' + (f' ({sub})' if sub else '') + ' — Folio')
        return True

    def cmd_setTheme(self, args, done):
        self.apply_theme(args)
        color = Gdk.RGBA()
        if isinstance(args.get('bg'), str) and color.parse(args['bg']):
            self.web.set_background_color(color)
        return True

    def cmd_saveSettings(self, args, done):
        window = self.settings.get('_window')
        self.settings = clean_settings(args.get('settings'))
        if window:
            self.settings['_window'] = window
        save_json(SETTINGS_FILE, self.settings)
        return True

    def cmd_fullscreen(self, args, done):
        if self.is_fullscreen():
            self.unfullscreen()
        else:
            self.fullscreen()
        return True

    def cmd_quit(self, args, done):
        self.allow_close = True
        GLib.idle_add(self.close)
        return True

    # ---------- lifecycle ----------

    def open_files(self, paths):
        if self.ready:
            self.js(f'folio.openFiles({json.dumps([self.docs.open(p) for p in paths])})')
        else:
            self.pending_files.extend(paths)
        self.present()

    def on_close_request(self, win):
        if self.allow_close or not self.ready:
            self.remember_size()
            return False

        def after(view, res):
            try:
                view.evaluate_javascript_finish(res)
            except GLib.Error:
                # The page is broken; don't trap the user.
                self.allow_close = True
                self.close()

        self.web.evaluate_javascript('folio.requestClose()', -1, None, None, None, None, after)
        return True

    def remember_size(self):
        w, h = self.get_default_size()
        self.settings['_window'] = {'w': w, 'h': h, 'max': self.is_maximized()}
        try:
            save_json(SETTINGS_FILE, self.settings)
        except OSError:
            pass


class FolioApp(Gtk.Application):
    def __init__(self):
        super().__init__(application_id=APP_ID, flags=Gio.ApplicationFlags.HANDLES_OPEN)
        self.window = None
        GLib.set_application_name('Folio')

    def ensure_window(self, files=()):
        if self.window is None:
            self.window = FolioWindow(self, files)
            self.window.present()
        elif files:
            self.window.open_files(list(files))
        else:
            self.window.present()

    def do_startup(self):
        Gtk.Application.do_startup(self)
        # Don't add opened/saved files to the desktop's "Recent files" list.
        Gtk.Settings.get_default().set_property('gtk-recent-files-enabled', False)
        remove_legacy_session()
        icon_dir = APP_DIR / 'icons'
        if icon_dir.is_dir():
            Gtk.IconTheme.get_for_display(Gdk.Display.get_default()).add_search_path(str(icon_dir))

    def do_shutdown(self):
        remove_legacy_session()
        Gtk.Application.do_shutdown(self)

    def do_activate(self):
        self.ensure_window()

    def do_open(self, files, n_files, hint):
        self.ensure_window([f.get_path() for f in files if f.get_path()])


def main():
    return FolioApp().run(sys.argv)


if __name__ == '__main__':
    sys.exit(main())
