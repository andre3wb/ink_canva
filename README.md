# Ink Canvas (S Pen) v2.2.0 – Handschrift, Textblöcke & Tabellen in Obsidian

Handschrift-Notizen auf einer **unendlichen Leinwand** wie in OneNote, optimiert für den **Samsung Galaxy S Pen**. Neu in v2.2.0: **Textblöcke & Tabellen zum Tippen** direkt auf der Leinwand sowie ein **ultra-flüssiger S-Pen-Radierer** ohne Ruckler oder Verbindungs-Aussetzer.

## Neu in Version 2.2.0

1. **Textblock- & Tabellen-Funktion (Tippen auf der Leinwand):**
   - **Neues Werkzeug „Textblock“ (`T`-Icon in der Toolbar):** Wähle das Textwerkzeug aus und tippe an eine beliebige Stelle der Leinwand, um sofort ein Textfeld zu erstellen und mit der Tastatur (Tablet oder PC) loszutippen.
   - **Integrierte Tabellen-Funktion (`⊞ Tabelle`):** Jeder Textblock kann optional um eine interaktive Tabelle ergänzt werden (über den Button **`⊞ Tabelle`** in der Kopfzeile des Textblocks, über die blaue Kontext-Toolbar oder über das Menü **`Datei +` → „Textblock mit Tabelle einfügen“**).
     - Mit `Tab` / `Shift+Tab` springst du nahtlos von Zelle zu Zelle (am Tabellenende fügt `Tab` automatisch eine neue Zeile an).
     - Zeilen und Spalten lassen sich jederzeit per Klick (`+ Zeile`, `+ Spalte`, `- Zeile`, `- Spalte`) erweitern oder verkleinern.
   - **Formatierung & Stil:**
     - Schriftgröße direkt im Textblock über **`A-`** / **`A+`** oder über die Verkleinern/Vergrößern-Buttons skalierbar.
     - Fettdruck (**`B`**), freie Textfarben-Wahl über die Farbpalette der Toolbar sowie umschaltbarer Hintergrund (**Karte**, **Notizzettel-Gelb** oder **Transparent**).
     - Nahtloses Zusammenspiel mit dem S Pen: Sobald Stift, Textmarker oder Radierer aktiv sind, kannst du problemlos über oder neben Textblöcke schreiben und markieren; per Doppeltipp im Hand-/Lasso-Modus oder Klick im Text-Modus bearbeitest du den Text weiter.
     - Vollständige Unterstützung für **Rückgängig/Wiederholen (Undo/Redo)**, **Duplizieren** und **PNG-Export**.

2. **Ultra-flüssiger S-Pen-Radierer & Seitentasten-Optimierung:**
   - **Lückenlose Echtzeit-Kollisionserkennung:** Neue kontinuierliche Segment-zu-Segment-Berechnung in Quadratdistanz (`segSegDistSq`) mit geschwindigkeitsabhängigem Radius-Boost – selbst schnelle Wischbewegungen erfassen jeden Strich sofort und ohne CPU-Ruckler.
   - **Kein Layout-Lag beim Radieren:** Das Neuzeichnen der Strich-Ebene (`invalidateStrokes`) ist nun vollständig von den DOM-Transformationen der PDF-Viewer und Textblöcke entkoppelt; zudem wurde die dreifache Event-Auswertung (`pointermove` vs. `pointerrawupdate` vs. `touchmove`) bereinigt.
   - **100 % zuverlässiges Verbinden beim Hin-und-Her-Radieren (Scrubbing):**
     - Sofortige **1-Frame-Hover-Erkennung** beim Drücken der S-Pen-Seitentaste.
     - Intelligentes **Scrubbing-Haltefenster**: Wenn die Stiftspitze beim schnellen Hin-und-Her-Radieren kurz angehoben wird, bleibt der Seitentasten-Radierer aktiv, solange die Taste gedrückt gehalten wird.
     - **Rückwirkendes Pfad-Radieren (`replayPts`)**: Falls Android das Seitentasten-Signal erst wenige Millisekunden nach dem Aufsetzen nachreicht, wird der zurückgelegte Anfangspfad sofort rückwirkend mitradiert.

## Neu in Version 2.1.1 & 2.1.0

- **S-Pen-Seitentaste (Halten = Radierer, Loslassen = vorheriger Stift):** Kein Einfrieren beim Aufsetzen auf das Display.
- **Nachträglicher PDF-Dateiaustausch (`⇄`):** Bereits eingebettete PDFs (Viewer-Fenster, Seiten-Ausdruck oder Anhang-Karte) jederzeit unter Beibehaltung aller handschriftlichen Notizen austauschen.

## Installation

1. Entpacke den Ordner `ink-canvas` in dein Vault nach:
   `<Vault>/.obsidian/plugins/ink-canvas/`
   (es müssen `main.js`, `manifest.json` und `styles.css` darin liegen)
2. Obsidian neu starten → *Einstellungen → Community-Plugins* → „Ink Canvas (S Pen)“ aktivieren.
