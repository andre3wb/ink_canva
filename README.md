# Ink Canvas (S Pen) v2.2.2 – Handschrift, Textblöcke & Tabellen in Obsidian

Handschrift-Notizen auf einer **unendlichen Leinwand** wie in OneNote, optimiert für den **Samsung Galaxy S Pen**. Neu in v2.2.2 / v2.2.0: **Textblöcke & Tabellen zum Tippen** direkt auf der Leinwand sowie ein **ultra-flüssiger S-Pen-Radierer** sowohl im Hover als auch beim Aufsetzen/Ziehen auf dem Display mit sofortiger Rückschaltung auf den Stift beim Loslassen.

## Neu in Version 2.2.2 (S-Pen Display-Kontakt & Hover Fix)

- **100 % flüssiger S-Pen-Knopf-Radierer beim Aufsetzen UND im Hover:**
  - **Fix gegen `contactHasBarrelBit`-Abbruch beim Aufsetzen:** Auf Samsung Galaxy Tab sendet Android beim Aufsetzen (`pointerdown`) oft das Barrel-Bit (`buttons & 32` / `buttons & 2`), während beim anschließenden Ziehen auf dem Display (`pointermove` / `pointerrawupdate`) nur noch `buttons === 1` gemeldet wird. Der fehlerhafte Abbruch nach 2 Frames bei `b === 1` während des Display-Kontakts wurde entfernt – der Radierer bleibt während des gesamten Display-Kontakts durchgehend eingerastet (`barrelContactLatched`).
  - **Fix gegen Doppelzählung bei `ACTION_HOVER_EXIT`:** `hoverClearFrames` wird nicht mehr doppelt durch `pointerrawupdate` + `pointermove` desselben Hardware-Frames hochgezählt, und `lastHoverBarrelTime` wird beim Übergang vom Hover zum Aufsetzen nicht vorzeitig gelöscht.
  - **Aktive Touch- & Pointer-Weiterführung beim Ziehen auf dem Display:** Sowohl `pointerrawupdate` / `pointermove` als auch `touchstart` / `touchmove` (`handleTouch`) führen den Radierer beim Aufsetzen mit voller 120Hz-Abtastrate weiter; künstliche `touchcancel`-Events von Android Chromium brechen den aktiven Radierer nicht mehr ab.
- **Zuverlässige Rückschaltung auf den Stift beim Loslassen der S-Pen-Seitentaste:**
  - Sofortige Rückschaltung im Hover (`pressure === 0 && buttons === 0`) sowie beim Abheben vom Display (`pointerup` / `touchend`).

## Neu in Version 2.2.0

1. **Textblock- & Tabellen-Funktion (Tippen auf der Leinwand):**
   - **Neues Werkzeug „Textblock“ (`T`-Icon in der Toolbar):** Wähle das Textwerkzeug aus und tippe an eine beliebige Stelle der Leinwand, um sofort ein Textfeld zu erstellen und mit der Tastatur (Tablet oder PC) loszutippen.
   - **Integrierte Tabellen-Funktion (`⊞ Tabelle`):** Jeder Textblock kann optional um eine interaktive Tabelle ergänzt werden (über den Button **`⊞ Tabelle`** in der Kopfzeile des Textblocks, über die blaue Kontext-Toolbar oder über das Menü **`Datei +` → „Textblock mit Tabelle einfügen“**).
     - Mit `Tab` / `Shift+Tab` springst du nahtlos von Zelle zu Zelle (am Tabellenende fügt `Tab` automatisch eine neue Zeile an).
     - Zeilen und Spalten lassen sich jederzeit per Klick (`+ Zeile`, `+ Spalte`, `- Zeile`, `- Spalte`) erweitern oder verkleinern.
   - **Formatierung & Stil:**
     - Schriftgröße direkt im Textblock über **`A-`** / **`A+`** oder über die Verkleinern/Vergrößern-Buttons skalierbar.
     - Fettdruck (**`B`**), freie Textfarben-Wahl über die Farbpalette der Toolbar sowie umschaltbarer Hintergrund (**Karte**, **Notizzettel-Gelb** oder **Transparent**).
     - Vollständige Unterstützung für **Rückgängig/Wiederholen (Undo/Redo)**, **Duplizieren** und **PNG-Export**.

2. **Ultra-flüssiger S-Pen-Radierer:**
   - Kontinuierliche Segment-zu-Segment-Kollisionserkennung in Quadratdistanz (`segSegDistSq`) mit geschwindigkeitsabhängigem Radius-Boost.
   - Entkoppeltes Neuzeichnen der Strich-Ebene (`invalidateStrokes`) ohne DOM-Layout-Verzögerungen.

## Installation

1. Entpacke den Ordner `ink-canvas` in dein Vault nach:
   `<Vault>/.obsidian/plugins/ink-canvas/`
   (es müssen `main.js`, `manifest.json` und `styles.css` darin liegen)
2. Obsidian neu starten → *Einstellungen → Community-Plugins* → „Ink Canvas (S Pen)“ aktivieren.
