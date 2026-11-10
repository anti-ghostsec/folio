# Folio

A calm, private text editor for Linux — made for writing first, code second.

Folio is a small GTK 4 app that hosts a hand-built editor UI in WebKit. It opens in a dark theme, keeps the
chrome out of your way, and forgets everything when you close it.

## Features

**Writing**
- Centered reading column with adjustable width, size and line spacing
- Three bundled typefaces: Literata (serif), Inter (sans), JetBrains Mono
- Four themes: Night (default), Ink, Paper, Sepia
- Spell check, live word count and reading time
- Markdown highlighting; lists and quotes continue on Enter
- Markdown preview (the eye button, Ctrl+Shift+M): the document formatted, read-only. Nothing in the file is run, and pictures aren't fetched (a picture shows as its description), so reading a document never tells a server so; links open in your browser
- Focus mode, typewriter scrolling, toolbars that fade while you type

**Code**
- Syntax colours for ~15 languages (Python, JS/TS, C/C++, Rust, Go, Java/Kotlin/C#, Shell, HTML/XML, CSS, JSON, YAML/TOML/INI, SQL, Lua, Ruby, PHP)
- Line numbers, auto-indent, Tab/Shift+Tab indenting
- Toggle comment (Ctrl+/), move line (Alt+↑/↓), duplicate line (Ctrl+Shift+D)

**General**
- A Save button (Ctrl+S) that lights up while there's something to save
- Tabs (drag to reorder), find & replace with regex, drag files onto the window to open
- Keeps CRLF line endings and the file's encoding when saving; atomic saves
- Reloads files changed on disk if you haven't edited them

## Privacy

The only thing Folio writes on its own is `~/.config/folio/settings.json` (theme, fonts, sizes, window size).

- It does not remember which files or notes were open. Every launch starts fresh.
- Unsaved notes exist only in memory; Folio asks before closing if any would be lost.
- The web view uses an ephemeral session — no cookies, cache or storage on disk.
- Opened and saved files are not added to the desktop's "Recent files" list.
- No network access, telemetry or update checks.

The editor page can't reach into your files on its own. It only gets a file you opened yourself (from the
command line or "Open with", the Open dialog, or by dropping it on the window), and Save As writes where the
Save dialog says, nowhere else. The page also loads nothing but Folio's own scripts, styles and fonts: a
content security policy rules out inline code and anything from a network.

## Requirements

- Python 3.10+
- GTK 4 and WebKitGTK 6.0 with GObject introspection

Debian / Ubuntu:

```bash
sudo apt install python3-gi gir1.2-gtk-4.0 gir1.2-webkit-6.0
```

Fedora:

```bash
sudo dnf install python3-gobject gtk4 webkitgtk6.0
```

Arch:

```bash
sudo pacman -S python-gobject gtk4 webkitgtk-6.0
```

## Run

```bash
python3 folio.py [FILE ...]
```

To add Folio to your app menu (and the "Open with" list):

```bash
./install.sh
```

`./install.sh --uninstall` removes it again.

To run the tests (they need nothing but Python):

```bash
python3 -m unittest discover -s tests
```

## Keyboard shortcuts

| Action | Keys |
| --- | --- |
| New note / Open / Save / Save as | Ctrl+N / Ctrl+O / Ctrl+S / Ctrl+Shift+S |
| Close tab / Quit | Ctrl+W / Ctrl+Q |
| Next / previous tab | Ctrl+Tab / Ctrl+Shift+Tab |
| Find / Replace | Ctrl+F / Ctrl+H |
| Text size | Ctrl+= / Ctrl+− / Ctrl+0 |
| Focus mode / Full screen | Ctrl+Shift+F / F11 |
| Markdown preview / back to editing | Ctrl+Shift+M / Esc |
| Settings | Ctrl+, |

## License

Code is MIT licensed (see [LICENSE](LICENSE)). The bundled fonts are under the SIL Open Font License 1.1 —
see [ui/fonts/licenses](ui/fonts/licenses).
