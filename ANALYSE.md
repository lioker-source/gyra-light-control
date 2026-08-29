# Atrium Light – Analyse Ist-Stand & Ziele

Stand: 2026-08-29 · Basis: `frontend/index.php` (1917 Z.), `backend/server.js` (1077 Z.), `database/schema.sql`

---

## 1. Systemüberblick

```
Tablet/Browser ──ws://<server>:8080──> Node "lightserver" ──Art-Net/UDP:6454──> DMX-Node ──> Fixtures
   (index.php)        JSON-Messages       40 Hz Tick-Loop         Unicast
                                              │
                                              └── MySQL/MariaDB "lichtsteuerung"
                                                  (Patch, Presets, ML-Positionen, Settings)
```

- **Frontend**: eine einzige PHP-Datei, liefert statisches HTML/JS aus. PHP tut nur eins: `$_SERVER['SERVER_ADDR']` in die WS-URL schreiben. Kein Build, kein Framework, W3.CSS vom CDN.
- **Backend**: Node.js (`ws`, `mysql2`, `dotenv`), zustandsbehaftet im RAM, DB nur zum Laden/Speichern.
- **Deployment**: `/opt/lightserver/server.js` unter PM2 (alternativ systemd-Unit), Frontend über Apache/PHP.

### Datenmodell (Ist)

| Tabelle | Zweck |
|---|---|
| `dmx_channels` | Patch: Name, Universe, Adresse, `channel_group`, `sort_order` |
| `ml_fixtures` | Movinglights: Verweise auf Kanal-IDs für Pan/Pan-Fine/Tilt/Tilt-Fine/Zoom/Dimmer |
| `light_presets` | Preset-Slots (`page` + `fader_index`, unique) |
| `light_preset_values` | Preset → Kanal → `max_value` |
| `ml_positions` | 9 Positions-Slots (`button_index`), pan/tilt/zoom normiert + `fade_time_sec` |
| `ml_settings` | Key/Value, aktuell nur `pad_sensitivity` |

**Kein echter Produktiv-Dump vorhanden.** Der reale Patch (welche Fixtures, welche Adressen) ist daher unbekannt; aus dem Code lässt sich nur ableiten: mindestens 1 Movinglight, dessen Fixture-Kanäle 8–14 den `dmx_channels`-IDs 33–39 entsprechen (hart im Code).

### Signalfluss im Backend (40 Hz Tick)

1. `updateMlState(dt)` – Positions-Fade, Joystick-Integration (Velocity → Position)
2. `mixSceneChannelsHTP()` – pro Kanal `max(alle Preset-Fader × preset-Wert, Programmer-Wert)`
3. `buildDmxUniverses()` – Szenenkanäle als 8 bit; danach ML-Kanäle **überschreibend**: Pan/Tilt 16 bit (Pan invertiert `1-pan`), Zoom 8 bit, Dimmer 8 bit HTP mit Szene; zuletzt IDs 33–39 hart auf 255
4. `sendDmx()` – ein ArtDMX-Paket je Universe, Unicast an `ARTNET_HOST`

### WebSocket-Protokoll

**Client → Server**: `ml_live` (velocity/absolut, zoom, dimmer), `ml_sensitivity`, `preset_fader`, `programmer_channel`, `save_preset`, `ml_pos_store`, `ml_pos_recall` (+ Legacy `save_ml_position` / `recall_ml_position`).
**Server → Client**: `init_state` (Presets, Kanäle, ML-State, Sensitivity), `preset_saved`, `ml_position_saved`, `ml_position_recalled`, `pad_sensitivity`, `error`.

### Bedienkonzept Frontend

- **Tab „Live"**: Preset-Fader (horizontal scrollend) · Sensitivity-Fader · quadratisches Touch-Pad · Zoom-/Dimmer-Fader · 9 Positions-Buttons (kurz = Recall, 600 ms halten = Store).
- **Pad**: 1 Finger = Joystick (Auslenkung → Geschwindigkeit, kein absolutes Zeigen); 2 Finger Pinch = Zoom, 2 Finger vertikal = Dimmer.
- **Gamepad**: linker/rechter Stick = Pan/Tilt (grob/fein), Trigger = Zoom, LB/RB = Dimmer, A/Y = Dimmer-Fade 0/100 %, B/X = Zoom-Fade 0/100 %.
- **Tab „Programmer"**: ein Fader je DMX-Kanal, ein Namensfeld, 16 Buttons „Speichern als Preset N".

---

## 2. Befunde

### A. Funktionale Fehler

| # | Befund | Ort |
|---|---|---|
| A1 | **ML-Dimmer wirkt nicht direkt.** Die Glättung `mlState.dimmer += (mlDimmerTarget - …)` steht **innerhalb** von `if (mlPositionFade)`. `mlPositionFade` wird aber nirgends gesetzt (Recall setzt hart und nullt es). ⇒ `mlState.dimmer` bleibt dauerhaft 0; der Dimmer-Fader schickt Werte, die nie ankommen. Sichtbar wird der ML nur über die HTP-Mischung mit Szenenwerten. | `server.js:288-300` |
| A2 | **Positions-Fades sind tot.** `fade_time_sec` wird gespeichert und geloggt, aber Recall setzt hart (`mlPositionFade = null`). Der gesamte Fade-Code läuft nie. | `server.js:810-820` |
| A3 | **Hart kodierte Kanal-IDs 33–39 auf 255.** Fixture-Konstanten (vermutlich Farbrad/Gobo/Shutter/Prisma des ML) im Code statt in der DB. Bricht bei jeder Patch-Änderung; blockiert diese Kanäle im Programmer. | `server.js:473-489` |
| A4 | **Zoom-Fader nach Recall inkonsistent.** `recallPositionSlot()` synchronisiert nicht, `syncZoomDimmerFadersFromState()` prüft `window.dimmerFaderState` (immer undefined bei `let`) ⇒ Dimmer-Fader springt nicht mit. | `index.php:1878` |
| A5 | **Pad zeigt Auslenkung, nicht Position.** Der Punkt visualisiert die Joystick-Deflection; die echte Pan/Tilt-Position des ML ist im UI nirgends sichtbar und wird vom Server nie zurückgemeldet. | Konzept |
| A6 | **Kein State-Broadcast.** Preset-Fader, Positions-Recalls u. a. gehen nur an den auslösenden Client. Zwei Tablets laufen sofort auseinander. | `server.js` |
| A7 | `loadPresets()` + `loadPadSettings()` bei **jedem** Connect; Reconnect-Storm = DB-Last. | `server.js:552` |
| A8 | Nur Slot-Suche auf `page = 1`; `light_presets.page` ist im Schema, im UI aber ohne Funktion. | `index.php:1729` |

### B. Bedienbarkeit

- **Statusanzeige ist per CSS komplett ausgeblendet** (`#status, #ws-debug, #values { display:none !important }`). Der Nutzer sieht nicht, ob die WS-Verbindung steht — bei einem Live-Pult das größte Problem.
- **Kein Blackout / Grandmaster / „alles aus"** — im Live-Betrieb Pflicht.
- **Positions-Buttons heißen nur „1"–„9"** — Namen stehen in der DB, werden nie ausgeliefert.
- **Preset-Speichern ohne Rückfrage**: „Speichern als Preset 3" überschreibt sofort, kein Undo, kein Löschen, kein Umbenennen.
- **Programmer zeigt alle Kanäle ungefiltert**, inkl. Pan/Tilt/Fine des ML. Diese werden nachgelagert überschrieben ⇒ Fader ohne Wirkung, wirkt wie ein Defekt. `channel_group` existiert im Schema, wird nirgends genutzt.
- **Programmer-Fader haben keinen Zahlenwert** (kein %/DMX-Readout), kein „auf 0", kein Clear-All.
- **Nur ein globaler ML-State für alle Fixtures** — Einzelauswahl oder Gruppen sind nicht vorgesehen.
- Kein Feedback beim Preset-Speichern (Bestätigung landet im versteckten `#status`).
- Nur Portrait/Landscape-Umbruch, keine Anpassung an unterschiedliche Tabletgrößen; Fader-Maße sind Pixel-Konstanten.

### C. Technik / Betrieb

- Kein Git-Repository, keine Tests, kein Lint, keine CI.
- Vier nahezu identische Fader-Implementierungen (Preset, Programmer, Sensitivity, Value) — ~600 Zeilen Duplikat.
- `ws://` ohne TLS, **keinerlei Authentifizierung** — wer im Netz ist, steuert das Licht.
- WS-Port im Frontend hart auf 8080.
- Art-Net nur Unicast an eine IP, kein Broadcast/mehrere Nodes, keine ArtPoll/Sync.
- `DEBUG_WS_IN = true` in Produktion ⇒ jede eingehende Nachricht wird geloggt (bei 20 Hz Pad-Traffic).
- Sender läuft dauerhaft mit 40 Hz, auch ohne Änderung (bei DMX korrekt, aber ohne Idle-Drosselung).
- Alte Legacy-Message-Typen parallel gepflegt.

---

## 3. Ziele für die Überarbeitung

### Priorität 1 – Korrektheit & Live-Sicherheit
1. A1 fixen: Dimmer-Glättung aus dem Fade-Block herausziehen.
2. Verbindungsstatus **sichtbar** machen (Ampel im Header, „getrennt"-Overlay).
3. Blackout-Button + Grandmaster-Fader.
4. Fixture-Konstanten (IDs 33–39) in die DB verlagern → neue Tabelle `dmx_channel_defaults` oder Spalte `fixed_value` in `dmx_channels`.
5. Preset-Überschreiben bestätigen lassen; sichtbares Erfolgs-/Fehler-Feedback.

### Priorität 2 – Bedienbarkeit
6. State-Broadcast an alle Clients + periodischer `state_update` (Pan/Tilt/Zoom/Dimmer, Preset-Level) → echte Multi-Tablet-Tauglichkeit und echte Positionsanzeige im Pad.
7. Positions-Buttons mit Namen und „belegt/leer"-Kennzeichnung; Umbenennen und Löschen im UI.
8. Programmer nach `channel_group` gruppieren (Tabs/Sektionen), ML-Steuerkanäle ausblenden oder als „gesperrt" markieren; Wertanzeige in % und DMX; „Clear Programmer".
9. Preset-Seiten (`page`) im UI nutzen: Seitenumschalter statt einer endlos scrollenden Leiste.
10. Positions-Fades aktivieren (A2) mit einstellbarer Fadezeit pro Slot.

### Priorität 3 – Erweiterungen
11. Fixture-/Gruppenauswahl für Movinglights statt eines globalen ML-States.
12. Patch-Editor im Frontend (Kanäle anlegen/umbenennen/adressieren) statt SQL von Hand.
13. Einfache Cues/Chaser oder wenigstens Preset-Fade-Zeiten.
14. Zugriffsschutz (PIN-/Token-Login), optional `wss://` hinter Reverse-Proxy.

### Priorität 4 – Code & Betrieb
15. Git-Repo initialisieren.
16. Frontend in `index.php` + `app.js` + `app.css` trennen; **eine** wiederverwendbare Fader-Komponente.
17. Debug-Logs per ENV-Flag statt Konstante; Legacy-Message-Typen entfernen.
18. Testumgebung (siehe unten).

---

## 4. Testumgebung – Stand

**Steht** (Docker, siehe README): MariaDB mit Test-Patch, Node-Backend,
PHP-Frontend, Art-Net-Monitor als Hardware-Ersatz. Damit ist der komplette
Signalweg ohne Anlage und ohne Produktiv-Dump testbar. Ende-zu-Ende verifiziert:
Preset-Fader und Programmer-Kanal → korrekte DMX-Bytes im Monitor.

Dabei bereits erledigt:
- `dmx_channels.fixed_value` ersetzt die hart kodierten IDs 33–39 (Befund A3).
- Debug-Flags über ENV statt Konstanten.
- WS-Host im Frontend konfigurierbar (`?ws=`, `LIGHT_WS_HOST`, sonst Browser-Host).
- Konstant gehaltene Kanäle werden im Programmer ausgeblendet.

**Offen / später nötig:**
- **Echter Patch**: der Produktiv-Dump ist nicht beschaffbar. Der Patch wird
  daher später direkt in der Anwendung neu angelegt → spricht für Ziel 12
  (Patch-Editor im Frontend), sonst bleibt es Handarbeit in SQL.
- **Kanalbelegung Hero Spot 300 TW**: in `seed.test.sql` geraten. Beim echten
  Patchen anhand des Handbuchs korrigieren.
- Art-Net-Node-IP und Universe-Zuordnung für den Realbetrieb.
- Zielgerät des Frontends (Tabletmodell/Größe) und ob das Gamepad im Einsatz ist.
- Automatisierte Smoke-Tests gegen das WS-Protokoll (Nachricht rein → erwartete
  DMX-Bytes raus) – der Monitor liefert dafür bereits eine JSON-API unter
  `/api/state`.
