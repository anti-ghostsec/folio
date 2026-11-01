#!/bin/sh
# Add Folio to the app menu for the current user.  ./install.sh --uninstall removes it.
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"

if [ "$1" = "--uninstall" ]; then
    rm -f "$APPS/folio.desktop" "$ICONS/folio.svg"
    update-desktop-database "$APPS" 2>/dev/null || true
    echo "Folio removed from the app menu."
    exit 0
fi

mkdir -p "$APPS" "$ICONS"
cp "$DIR/icons/hicolor/scalable/apps/folio.svg" "$ICONS/folio.svg"
chmod +x "$DIR/folio.py"

cat > "$APPS/folio.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=Folio
GenericName=Text Editor
Comment=A calm, private editor for writing and code
Exec=python3 "$DIR/folio.py" %F
Icon=folio
Terminal=false
Categories=Utility;TextEditor;
MimeType=text/plain;text/markdown;text/x-python;application/json;text/html;text/css;application/javascript;application/x-shellscript;
StartupNotify=true
EOF

update-desktop-database "$APPS" 2>/dev/null || true
echo "Folio added to the app menu."
