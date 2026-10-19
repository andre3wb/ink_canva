# Ink Canvas (S Pen) – Handschrift in Obsidian

Handschrift-Notizen auf einer **unendlichen Leinwand** wie in OneNote, optimiert für den **Samsung Galaxy S Pen**. PDFs lassen sich als „Ausdruck“ einfügen und direkt darüber beschreiben.

## Installation

1. Entpacke den Ordner `ink-canvas` in dein Vault nach:
   `<Vault>/.obsidian/plugins/ink-canvas/`
   (es müssen `main.js`, `manifest.json` und `styles.css` darin liegen)
2. Obsidian neu starten → *Einstellungen → Community-Plugins* → „Ink Canvas (S Pen)“ aktivieren.

Auf dem Galaxy Tablet/Handy: Den Ordner per USB oder Cloud in `<Vault>/.obsidian/plugins/` kopieren (der Ordner `.obsidian` ist versteckt – ggf. versteckte Dateien anzeigen). Einfacher: Vault per Obsidian Sync/Syncthing/Drive synchronisieren.

## Benutzung

- **Neue Notiz:** Stift-Symbol in der linken Leiste oder Befehl „Neue Handschrift-Notiz erstellen“. Es entsteht eine `.ink`-Datei im Vault.
- **PDF einfügen:** Toolbar-Button „Datei +“ oder Befehl „PDF in Handschrift-Notiz einfügen“. Alternativ Rechtsklick/Lange drücken auf eine PDF → „Mit Handschrift beschriften“.
- **Schreiben:** Nur der S Pen schreibt (Druckempfindlichkeit wird unterstützt). Der Finger schiebt die Leinwand, zwei Finger zoomen. Handballen werden ignoriert.
- **S-Pen-Taste gedrückt halten** = Radierer (löscht ganze Striche). Unter *Einstellungen → Ink Canvas* kannst du stattdessen „Leinwand verschieben“ oder „Keine Aktion“ wählen. Reagiert die Taste nicht, schalte „Tasten-Diagnose“ ein – sie zeigt den erkannten Tastenwert beim Aufsetzen an.
- **Werkzeuge:** Stift, Textmarker, Radierer, Lasso, Verschieben.
- **Glättung:** Schieberegler „Wellen“ in der Werkzeugleiste (und in den Einstellungen). 0 = rohe Eingabe, höher = ruhigere Linien.
- **Formerkennung:** Zeichne eine Linie, einen Kreis/Ellipse, ein Dreieck, Rechteck oder Vieleck und halte den Stift am Ende kurz ruhig – die Form wird begradigt (leichtes Vibrieren auf dem Gerät). Bei Linien kannst du den Endpunkt danach noch ziehen (rastet bei 0°/45°/90° ein). Ein-/Ausschalten über den „Formen“-Knopf, Haltezeit in den Einstellungen.
- **Lasso:** Striche einkreisen → Auswahl. Innerhalb des Rahmens ziehen verschiebt, der runde Griff unten rechts skaliert. Außerdem: vergrößern/verkleinern (Knöpfe), duplizieren, löschen.
- **PDF-Ausdruck:** Mit dem Verschieben-Werkzeug ein PDF antippen → Rahmen mit Griff. Ziehen verschiebt das PDF samt Beschriftung, der Griff unten rechts oder die Knöpfe vergrößern/verkleinern die ganze Gruppe samt Beschriftung. „Entgruppieren“ teilt das PDF in Einzelseiten, die du einzeln verschieben und skalieren kannst (Rückgängig stellt die Gruppe wieder her).
- **Hintergrund:** Karo / Linien / Punkte / Blanko durchschalten.
- **Export:** „Als PNG exportieren“ legt ein Bild neben die Notiz und kopiert `![[…png]]` in die Zwischenablage, damit du die Handschrift in normale Markdown-Notizen einbetten kannst.
- **Desktop:** Mausrad = scrollen, Strg + Mausrad = zoomen, rechte/mittlere Maustaste = Leinwand schieben.

## Hinweise

- Das PDF bleibt unverändert im Vault; die Notiz speichert nur den Verweis und deine Striche.
- Wird ein PDF verschoben oder umbenannt, erscheint „PDF fehlt“ – Pfad in der `.ink`-Datei anpassen oder PDF neu einfügen.
- Einstellungen (Finger zeichnet, PDF-Qualität, Standard-Hintergrund) unter *Einstellungen → Ink Canvas*.
