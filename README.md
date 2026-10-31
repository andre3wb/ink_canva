# Ink Canvas (S Pen) v2.1.1 – Handschrift in Obsidian

Handschrift-Notizen auf einer **unendlichen Leinwand** wie in OneNote, optimiert für den **Samsung Galaxy S Pen**. PDFs lassen sich als **Viewer-Fenster**, **Seiten-Ausdruck** oder **Anhang-Karte** einfügen, direkt darüber beschreiben und jederzeit nachträglich austauschen.

## Neu in Version 2.1.1 (Bugfix Release)

- **S-Pen-Seitentaste Bugfix (Kein Einfrieren beim Aufsetzen):**
  - Behebt das Problem aus v2.1.0, bei dem die Seitentaste zwar auf den Radierer umschaltete, das Radierwerkzeug jedoch beim Aufsetzen der Stiftspitze auf das Display einfror (durch Androids `pointercancel` / `StylusTextSelector`-Unterbrechung sowie die Kontakt-Sperre).
  - Unterbindet Androids Gesten-Abbruch bei gehaltener Seitentaste (`touchstart`/`touchmove` mit aktivem `preventDefault()`), führt Bewegungen nahtlos über `pointermove`, `pointerrawupdate` und `touchmove`-Fallback fort und gibt beim Loslassen der Taste sofort wieder den vorher benutzten Stift frei.

## Neu in Version 2.1.0

1. **Nachträglicher PDF-Dateiaustausch (für alle Einbettungsarten):**
   - Bereits eingebettete PDFs (egal ob **Viewer-Fenster**, **Seiten-Ausdruck** oder **Anhang-Karte**) lassen sich jederzeit nachträglich gegen eine andere PDF-Datei aus dem Vault austauschen – Position, Skalierung und deine handschriftlichen Notizen bleiben dabei erhalten (inkl. Rückgängig/Wiederholen).
   - **Wege zum Ändern:**
     - PDF mit dem Hand-/Lasso-Werkzeug auswählen → Button **„PDF-Datei ändern“** in der blauen Kontext-Leiste der Toolbar.
     - Im eingebetteten **PDF-Viewer-Fenster** direkt über den Button **`⇄`** in der Titelleiste.
     - Auf einer **PDF-Anhang-Karte** direkt über den Button **`⇄`** neben `Öffnen ↗`.
     - Über das Toolbar-Menü **„Datei +“ → „Eingebettete PDF-Datei ändern …“** oder per Rechtsklick auf ein PDF-Element auf der Leinwand.
2. **S-Pen-Seitentaste (Halten = Radierer, Loslassen = vorheriger Stift):**
   - Solange der seitliche Knopf am S Pen gedrückt gehalten wird, wechselt das aktive Werkzeug automatisch und sichtbar in der Toolbar auf den **Radierer** (inkl. rotem Vorschau-Kreis).
   - Sobald der seitliche Knopf losgelassen wird, springt das Werkzeug sofort wieder zurück auf den **vorher benutzten Stift** (z. B. Stift oder Textmarker).

## Installation

1. Entpacke den Ordner `ink-canvas` in dein Vault nach:
   `<Vault>/.obsidian/plugins/ink-canvas/`
   (es müssen `main.js`, `manifest.json` und `styles.css` darin liegen)
2. Obsidian neu starten → *Einstellungen → Community-Plugins* → „Ink Canvas (S Pen)“ aktivieren.
