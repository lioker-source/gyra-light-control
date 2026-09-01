# Atrium Light – Analyse Ist-Stand & Ziele

Stand: 2026-09-01 · Basis: `frontend/index.php` (1940 Z.), `backend/server.js` (1764 Z.), `database/schema.sql`

Die Befunde in Abschnitt 2 sind am 2026-08-29 einzeln gegen den aktuellen
Code geprüft und tragen jeweils einen Status.

---

## 1. Systemüberblick

```
Tablet/Browser ──ws://<server>:8080──> Node "lightserver" ──Art-Net/UDP:6454──> DMX-Node ──> Fixtures
   (index.php)        JSON-Messages       40 Hz Tick-Loop    Unicast/Broadcast
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
4. `sendDmx()` – ein ArtDMX-Paket je Universe, je nach `ARTNET_MODE` Unicast
   an `ARTNET_HOST` oder Broadcast an `ARTNET_BROADCAST_ADDR`

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

| # | Befund | Ort | Status |
|---|---|---|---|
| A1 | **ML-Dimmer wirkte gar nicht.** Die Glättung stand **innerhalb** von `if (mlPositionFade)`, und `mlPositionFade` wird nirgends je auf ein Objekt gesetzt ⇒ `mlState.dimmer` bekam an keiner Stelle einen Wert und blieb dauerhaft 0. | `server.js:311-353` | **erledigt 2026-08-29** – Glättung als eigener Schritt 3 hinter den Fade-/Joystick-Block gezogen, `DIMMER_SMOOTHING_SEC` zu den übrigen ML-Parametern hochgezogen. Ende-zu-Ende verifiziert: `dimmer` 0.5/0.0/1.0 → DMX-Kanal 24 = 128/0/255 |
| A2 | **Positions-Fades waren tot.** Beide Recall-Handler lasen `fade_time_sec` in eine nie verwendete Variable `fade` und setzten hart. | `server.js:839/846-848`, `950/955-957` | **erledigt 2026-08-29** – siehe B1.1 in Abschnitt 5 |
| A3 | Hart kodierte Kanal-IDs 33–39 auf 255. | `server.js` | **erledigt** – ersetzt durch `dmx_channels.fixed_value`; solche Kanäle werden im Programmer ausgeblendet (`index.php:1726`) |
| A4 | **Dimmer-Fader springt nach Recall nicht mit.** `window.dimmerFaderState` ist wegen `let` immer `undefined` ⇒ der Block läuft nie. | `index.php:545, 1914` | **entfällt** – Frontend wird neu gebaut |
| A5 | **Pad zeigt Auslenkung, nicht Position.** Der Punkt visualisiert die Joystick-Deflection; die echte Pan/Tilt-Position des ML ist im UI nirgends sichtbar und wird vom Server nie zurückgemeldet. | Konzept | **offen** |
| A6 | **Kein State-Broadcast.** `broadcast()` ist implementiert, wird aber nur für `pad_sensitivity` benutzt. Preset-Fader, Positions-Recalls usw. gehen nur an den auslösenden Client. Zwei Tablets laufen sofort auseinander. | `server.js:597, 659` | **offen** |
| A7 | `loadPresets()` + `loadPadSettings()` bei **jedem** Connect; Reconnect-Storm = DB-Last. | `server.js:584-589` | **offen** |
| A8 | Preset-Seiten unbenutzbar: das Frontend sendet `page` fest als `1`. Backend und Schema können mehrere Seiten. | `index.php:1798` | **offen** |
| A9 | *(Frontend-Ursache entfällt mit dem Neubau; die Protokoll-Konsequenz steht als B2.8 in Abschnitt 5.)* **Jeder offene Browser-Tab sendet permanent mit 20 Hz.** `gamepadLoop()` läuft über `requestAnimationFrame` bedingungslos — ohne Gamepad, ohne Pad-Berührung — und ruft am Ende `sendStateToServer()`. Der Tab drückt damit dauerhaft seinen lokalen Zoom-/Dimmer-Stand auf den Server. Folgen: (a) zusammen mit A6 überschreiben sich zwei Tablets 20-mal pro Sekunde gegenseitig, statt nur auseinanderzulaufen; (b) kein anderer Client und kein Testskript kann `mlState` bewegen, solange irgendein Tab offen ist; (c) unnötige Dauerlast auf WS und CPU. Gemessen: ein offener Tab hat Zoom dauerhaft auf 128 (=0.5) und Dimmer auf 0 festgenagelt. | `index.php:1223, 1227` | **offen** |

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

- Keine Tests, kein Lint, keine CI. (Git-Repo existiert inzwischen.)
- Vier nahezu identische Fader-Implementierungen (Preset, Programmer, Sensitivity, Value) — ~600 Zeilen Duplikat.
- `ws://` ohne TLS, **keinerlei Authentifizierung** — wer im Netz ist, steuert das Licht.
- WS-Port im Frontend hart auf 8080.
- Art-Net: Unicast/Broadcast ist jetzt per `ARTNET_MODE` umschaltbar. Weiterhin
  offen: kein ArtPoll/ArtPollReply (der Server ist für Nodes nicht auffindbar),
  kein ArtSync, und das Sequence-Feld bleibt konstant 0 — laut Spec zulässig
  („sequencing disabled"), aber ohne Schutz gegen vertauschte Pakete.
- Debug-Logging läuft jetzt über ENV-Flags. Im Frontend stehen aber noch
  vergessene `console.log`-Aufrufe im 20-Hz-Pfad: `'FaderMove'` und `travel`
  bei jeder Fader-Synchronisation (`index.php:1900, 1909`), dazu
  `'recalled'+zoom` (`index.php:627`).
- Sender läuft dauerhaft mit 40 Hz, auch ohne Änderung (bei DMX korrekt, aber ohne Idle-Drosselung).
- Alte Legacy-Message-Typen parallel gepflegt.

### D. Art-Net-Ausgabe & Testumgebung

Befunde aus der Inbetriebnahme mit MA3 / Artnetominator am 2026-08-29.

| # | Befund | Status |
|---|---|---|
| D1 | **Aus dem Container erreicht Broadcast den Host nie.** Unter Docker Desktop (WSL2) endet ein Broadcast im Bridge-Netz der VM; auch das Bridge-Gateway `172.19.0.1` liegt in der VM, nicht auf Windows. Gemessen: Pakete an `172.19.0.1` kommen nicht an, an `host.docker.internal` (192.168.65.254) schon — und zwar mit Quelladresse `127.0.0.1`. Für Tools auf dem Host gilt deshalb `ARTNET_MODE=unicast` + `ARTNET_HOST=host.docker.internal`. | dokumentiert im README, **Workaround** |
| D2 | **Echte Art-Net-Hardware im LAN ist aus dem Docker-Setup nicht bedienbar.** | **gelöst 2026-08-29** – über den nativen Betrieb (B4.1, `ops/start-native.sh`). Der Docker-Weg bleibt unverändert nur für den Monitor tauglich. |
| D3 | **Backend konnte nicht nativ gegen die Docker-DB laufen.** `mysql.createPool()` übergab keinen `port`, nutzte also immer 3306; die Testdatenbank hängt auf 3307. | **erledigt 2026-08-29** – `DB_PORT` aus der ENV (Default 3306), in `backend/.env(.example)` und `docker-compose.yml` ergänzt. Verifiziert: Verbindung über 3307 liefert 37 Kanäle, Gegenprobe auf 3306 `ECONNREFUSED`. Für den nativen Betrieb ist vorher `npm install` in `backend/` nötig — der dortige `node_modules`-Ordner ist nur ein leerer Mountpunkt des Compose-Volumes. |
| D4 | **Bei Unicast bekommt nur *ein* Programm auf dem Host die Daten.** Lauschen mehrere Tools auf UDP 6454, gewinnt der spezifischere Bind: gemessen hat ein Socket auf `127.0.0.1` das Paket erhalten, der auf `0.0.0.0` nicht. Artnetominator (Loopback) schneidet damit MA3 (`0.0.0.0`) ab. Broadcast würde an alle zustellen — braucht aber D2. | **verstanden**, kein Codefehler |
| D5 | **Kanalbelegung des Hero Wash 300 TW war geraten** — und zwar falsch an entscheidender Stelle: rel. 6 ist Zoom (nicht Dimmer), rel. 7 ist der Dimmer (war als „Dimmer Fine" fest auf 0 genagelt), rel. 9-14 sind die sechs Kalt-/Warmweiss-Segmente (das eigentliche Leuchtmittel, standen auf 0). Der Dimmer konnte deshalb gar nicht wirken. | **erledigt 2026-08-29** – Belegung aus dem Handbuch übernommen: Zoom→24, Dimmer→25, Stroboskop 26 fest 255, Segmente 27-32 fest 255, Farbtemperatur 33 fest 128, 34-37 fest 0. `seed.test.sql` korrigiert **und** per `UPDATE` in die laufende DB gezogen (ohne `down -v`, Presets blieben erhalten). |
| D6 | **`seed.test.sql` greift nur bei leerer DB.** Änderungen am Test-Patch erfordern `docker compose down -v` — dabei gehen lokal angelegte Presets und ML-Positionen verloren. Ein Migrations-/Reset-Skript fehlt. | **teilweise** – der MA3-Patch ist inzwischen geladen (37 Kanäle, verifiziert), das fehlende Reset-Skript bleibt offen |
| D7 | **Keine `.gitignore`.** | **erledigt 2026-08-29** – siehe B4.3 in Abschnitt 5. |

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
- Art-Net Unicast/Broadcast per `ARTNET_MODE` umschaltbar (`ARTNET_BROADCAST_ADDR`,
  `ARTNET_PORT`); Ausgabeweg beim Start im Log sichtbar.
- `seed.test.sql` deckungsgleich mit dem MA3-Testpatch: 6 Dimmer (1–6),
  4x RGB (7–18), Hero Wash 300 TW (19–37), Kanal-ID = DMX-Adresse.
- Signalweg bis in MA3 verifiziert (Art-Net-Input empfängt Universe 0).

**Offen / später nötig:**
- **Echter Patch**: der Produktiv-Dump ist nicht beschaffbar. Der Patch wird
  daher später direkt in der Anwendung neu angelegt → spricht für Ziel 12
  (Patch-Editor im Frontend), sonst bleibt es Handarbeit in SQL.
- **Kanalbelegung Hero Wash 300 TW**: in `seed.test.sql` geraten (D5).
- Art-Net-Node-IP und Universe-Zuordnung für den Realbetrieb (D2).
- `DB_PORT` aus der ENV, damit das Backend auch nativ gegen die Docker-DB
  laufen kann (D3).
- Zielgerät des Frontends (Tabletmodell/Größe) und ob das Gamepad im Einsatz ist.
- Automatisierte Smoke-Tests gegen das WS-Protokoll (Nachricht rein → erwartete
  DMX-Bytes raus) – der Monitor liefert dafür bereits eine JSON-API unter
  `/api/state`.

---

## 5. Backend-Arbeitsliste

Das Frontend wird komplett neu gebaut — Frontend-Befunde (A4, A8-Client-Teil,
A9-Ursache, Abschnitt B) werden deshalb nicht mehr einzeln gefixt. Diese Liste
enthält nur, was am **Backend** zu tun ist. Reihenfolge = Vorschlag.

### B1 · Korrektheit

| # | Aufgabe | Ort |
|---|---|---|
| B1.1 | ~~Positions-Fades aktivieren (A2).~~ **erledigt 2026-08-29** – gemeinsamer Helfer `startPositionFade()` für beide Recall-Handler; bei `fade <= 0` weiterhin hartes Setzen. Der Interpolationscode in `updateMlState()` war die ganze Zeit korrekt, wurde nur nie ausgelöst. Die Antwort schickt jetzt das **Ziel** statt des Startwerts, dazu `fade_time_sec`. Verifiziert: 3-s-Fade von pan 0.9/tilt 0.1/zoom 0.9 nach 0.2/0.8/0.3 läuft linear, `fading` kippt true→false, Endwert exakt getroffen. | `server.js:640-665, 1051, 1163` |
| B1.2 | ~~Pan-Invertierung hart verdrahtet.~~ **erledigt 2026-08-29** – neue Spalten `ml_fixtures.pan_invert` / `tilt_invert` (Migration `database/migrations/2026-08-29-pan-tilt-invert.sql`, idempotent; auch in `schema.sql` und `seed.test.sql`). Die Migration setzt `pan_invert = 1` für bestehende Fixtures, damit sich die Laufrichtung **nicht** ändert. Am DMX in beide Richtungen verifiziert: mit `pan_invert=1` ergibt Eingabe 0.25 wie bisher 16-bit 49151 (norm 0.750); nach Tausch der Flags 16384 (norm 0.250) bei Pan und 0.750 bei Tilt. | `server.js:605-609` |

> **Nebenwirkung von B1.1, bewusst so:** Ein laufender Fade wird jetzt nur
> noch bei echter Bewegungsabsicht abgebrochen (Joystick über der Deadzone
> oder absolute Pan/Tilt-Vorgabe). Vorher brach *jede* `ml_live`-Nachricht ab —
> und weil ein ruhender v1-Tab mit 20 Hz `pan_speed: 0` sendet (A9), wäre kein
> Fade je durchgelaufen. Verifiziert: ruhender Client lässt den Fade laufen,
> ausgelenkter Joystick bricht ihn ab.
>
> Einschränkung mit v1-Clients: der Zoom-Anteil des Fades kämpft weiterhin
> gegen das `zoom`-Feld im 20-Hz-`ml_live`. Löst sich mit v2 (`ml.zoom` nur
> bei Änderung).

### B2 · Protokoll — Voraussetzung für das neue Frontend

> **`PROTOKOLL.md` (v2) ist serverseitig vollständig umgesetzt.** B2.1-B2.10
> sind erledigt, die vier Entscheidungen in §10 sind alle getroffen.

Diese Punkte zuerst festlegen, sonst baut das neue Frontend gegen ein Protokoll,
das gleich wieder geändert wird.

| # | Aufgabe | Ort |
|---|---|---|
| B2.1 | ~~State-Broadcast (A6).~~ **erledigt 2026-08-29** – `broadcast()` wurde bisher nur für `pad_sensitivity` benutzt. Neu: `buildStateMessage()` nach `PROTOKOLL.md` §4.3 mit `seq`, `origin`, `ml`, `master`, `preset_levels`, `programmer`, `pad_sensitivity`; jede Verbindung bekommt eine `client_id` als `origin`. Verifiziert mit zwei Clients: A setzt Preset 2 auf 0.7 → B sieht `preset_levels: {"2":0.7}` mit `origin`. | `server.js:640-720` |
| B2.2 | ~~Periodischer `state_update`.~~ **erledigt 2026-08-29** – eigener Takt mit `STATE_HZ` (Default 10), getrennt vom 40-Hz-DMX-Takt. Sendet nur bei Änderung, mindestens aber alle `STATE_KEEPALIVE_MS` (Default 1000) als Lebenszeichen. Isoliert gemessen: Leerlauf 3 Nachrichten in 3 s, Einschwingen des Dimmers 8, danach wieder 3. **Dabei gefunden:** die Dimmer-Glättung erreichte ihr Ziel asymptotisch nie exakt (`0.00023539…`), wodurch jeder Tick als Änderung galt und der Leerlauf nie still wurde — jetzt Snap auf den Zielwert unterhalb `DIMMER_EPSILON` (ein halber DMX-Schritt). **Einschränkung:** solange v1-Clients laufen, hebelt ein einziger offener Tab die Drosselung aus, weil er mit 20 Hz `ml_live` sendet (A9). Greift im Alltag erst mit v2-Clients, die nur bei Änderung senden. | `server.js:353-360, 1180` |
| B2.3 | ~~`ml_positions` werden nie ausgeliefert.~~ **erledigt 2026-08-29** – `loadPositions()` + `buildPositionList()` ergänzt, Slot-Anzahl über `POSITION_SLOT_COUNT` (Default 9). Alle Slots gehen in `init_state`, auch leere (`occupied: false`), und werden nach jedem Store aufgefrischt. Verifiziert: ein neu verbundener Client sieht Name und Belegung. **Dabei gefunden und mitgefixt:** `handleMlPosStore()` hatte `const fade = 1.0` fest verdrahtet und verwarf die vom Client geschickte `fade_time_sec` — das hätte B1.1 sofort wieder ausgehebelt. Kurios: der Legacy-Handler machte es richtig. Rückfallwert jetzt `DEFAULT_POSITION_FADE_SEC` (ENV `POSITION_FADE_SEC`). | `server.js:265-290, 844` |
| B2.4 | ~~Blackout und Grandmaster fehlen.~~ **erledigt 2026-08-29** – neue Spalte `dmx_channels.is_intensity` (Migration `database/migrations/2026-08-29-is-intensity.sql`, idempotent; auch in `schema.sql` und `seed.test.sql`). `applyMaster()` wirkt am Ende der HTP-Mischkette und auf den ML-Dimmer, ausschliesslich auf Intensitäten. Neue Nachrichten `master.grandmaster` / `master.blackout` — direkt in v2-Benennung, da ohne v1-Vorgänger. Am DMX verifiziert: GM 0.5 halbiert Dimmer 1-6 und Wash-Dimmer 25 auf 128, Blackout zieht sie auf 0, **Pan 19 / Tilt 21 bleiben bei 128 und Segment 27 bei 255**. | `server.js:286-300, 520` |
| B2.5 | ~~Kein „Clear Programmer“.~~ **erledigt 2026-08-29** – `programmer.clear` leert `programmerValues`. Verifiziert: `{"7":0.8}` → `{}`. | `server.js:1235` |
| B2.6 | ~~Legacy-Message-Typen entfernen.~~ **erledigt 2026-08-29** – `handleSaveMlPositionLegacy` und `handleRecallMlPositionLegacy` samt Fällen gelöscht, 102 Zeilen. Vorher geprüft, dass das Frontend `save_ml_position` / `recall_ml_position` nirgends sendet. | `server.js` |
| B2.7 | ~~Preset-Seiten im Protokoll sauber führen.~~ **erledigt 2026-08-29** – `preset.save` prüft jetzt `(page, fader_index)` und antwortet bei belegtem Slot mit `slot_occupied` statt in den Unique-Index zu laufen; dazu `preset.delete` und `position.delete`. Verifiziert: Seite 1/Fader 1 → „Seite 1, Fader 1 ist bereits mit 'Dimmer Full' belegt.“, Seite 2 legt sauber an, beide Löschbefehle greifen. | `server.js:1224, 1254` |
| B2.8 | ~~Führungslogik festlegen.~~ **erledigt 2026-08-29** – `ml.move` / `ml.goto` / `ml.zoom` / `ml.dimmer` ersetzen die Sammelnachricht; der Client schickt Absichten statt Zuständen. `ml.move` hat einen Totmann-Schalter (`ML_MOVE_TIMEOUT_MS`, Default 400 ms): bleibt die Auffrischung aus, geht die Geschwindigkeit auf 0, damit der Kopf nicht weiterfährt, wenn ein Tablet abstürzt. Verifiziert: Pan läuft nach dem letzten `ml.move` noch bis 0.411 und bleibt dort stehen. Alle v1-Namen laufen als Aliase weiter, bis das neue Frontend steht. | `server.js:1133-1165` |

> **Beim Testen von B2.7 aufgefallen:** `preset.save` und `position.store`
> haben ihre Änderung nur dem Absender bestätigt, während die neuen
> Löschbefehle die Bibliothek an alle verteilten — dieselbe Inkonsistenz, die
> A6 zugrunde lag. Beide rufen jetzt `broadcastLibrary()`. Verifiziert mit
> zwei Clients: B sieht Anlegen, Speichern und Löschen, ohne selbst zu senden.
>
| B2.9 | ~~Verbindungssequenz §2 (`hello` + `patch` + `library` + `state`).~~ **erledigt 2026-09-01** – `sendHandshake()` schickt die vier Nachrichten in dieser Reihenfolge; `state` geht dabei sofort raus statt auf den nächsten Takt zu warten, sonst sähe ein neuer Client bis zu `STATE_KEEPALIVE_MS` lang nichts. Neu: `buildPatchMessage()` (mit `is_intensity` und den Invert-Flags aus B1.2), `buildLibraryMessage()`, `buildPresetList()`, `buildChannelList()`. `broadcastLibrary()` verteilt jetzt ein schlankes `library` statt eines kompletten `init_state` an alle. **Dabei mitgefixt:** `system.reload` schickte nur die Bibliothek neu — ein Reload kann aber genauso den Patch geändert haben, deshalb geht jetzt `patch` **und** `library` raus. Verifiziert: Reihenfolge `hello → patch → library → state`, `protocol: 2`, 37 Kanäle, 1 ML-Fixture mit `pan_invert: true`, 9 Positionsslots inkl. leerer; mit zwei Clients sieht B ein `library` nach `preset.save` und `preset.delete` des Clients A, und nach `system.reload` bekommen beide `reloaded → patch → library`. | `server.js:1550-1660, 962, 1331` |

> **Übergangslösung:** `sendInitState()` heißt jetzt `sendInitStateLegacy()`
> und wird neben der v2-Sequenz weiter an jeden Client geschickt — sonst wäre
> das bestehende v1-Frontend sofort tot. Fällt zusammen mit den v1-Aliasen
> weg, sobald das neue Frontend steht.

### B2 · Nachtrag: offene Protokoll-Entscheidungen (§10)

| # | Aufgabe | Ort |
|---|---|---|
| B2.10 | ~~Die vier offenen Entscheidungen aus `PROTOKOLL.md` §10 klären.~~ **erledigt 2026-09-01** – (1) *Grandmaster auf den ML-Dimmer:* ja, bleibt wie gebaut — ein Blackout, der den Wash anlässt, wäre im Live-Betrieb eine böse Überraschung; kein Code betroffen. (2) *Preset-Quelle:* `channels` bleibt der explizite Normalfall, **fehlt es, friert der Server den Programmer ein** (Werte = 0 fallen raus). Verifiziert: Programmer 3→0.75 / 5→0.25, `preset.save` ohne `channels`, danach in der DB genau diese beiden Zeilen; `programmer.clear` + Fader auf 100 % lässt das Preset stehen. (3) *`position.store` ohne Koordinaten:* bleibt, dazu neu **`position.update`** für Name und Fadezeit — vorher liess sich ein Slot weder umbenennen noch seine Fadezeit korrigieren, ohne den Kopf dorthin zu fahren und die Position zu überschreiben. Verifiziert: Umbenennen von „Original“ auf „Umbenannt“ mit 2.0→5.5 s, anschliessender Recall trifft weiterhin pan 0.300 / tilt 0.700; leerer Slot → `not_found`, kein Feld gesetzt → `bad_request`. (4) *Authentifizierung:* bewusst keine, wie am 2026-08-29 entschieden (B3.4). | `server.js:1380, 1345` |

### B3 · Robustheit & Betrieb

| # | Aufgabe | Ort |
|---|---|---|
| B3.1 | ~~`loadPresets()` + `loadPadSettings()` bei jedem Connect.~~ **erledigt 2026-08-29** – `sendInitState()` liefert aus dem Cache, ohne DB-Zugriff. Konfigurationsänderungen kommen über `reloadAll()` (B3.3) herein; damit entfällt der Grund für das Laden pro Verbindung. Gemessen: 5 Reconnects erzeugen 0 zusätzliche DB-Ladevorgänge (vorher 2 je Verbindung). | `server.js:790` |
| B3.2 | ~~Kein WS-Heartbeat.~~ **erledigt 2026-08-29** – `ping`/`pong` mit `isAlive` je Verbindung, Takt über `WS_PING_INTERVAL_MS` (Default 15000), Timer wird bei `wss.close` aufgeräumt. Verifiziert mit zwei Clients: der aktive bekommt Pings und überlebt, ein per `socket.pause()` verstummter (TCP offen, keine Antwort — wie ein eingeschlafenes Tablet) wird erkannt und beendet: `Keine Antwort von cf0404, Verbindung wird beendet.` Ein hart abgerissener Socket wird ohnehin schon per TCP-RST erkannt. | `server.js:715-735` |
| B3.3 | ~~`loadPatch()` läuft nur beim Start.~~ **erledigt 2026-08-29** – `reloadAll()` lädt Patch, Presets, Positionen und Settings neu; ausgelöst per **SIGHUP** (`docker compose kill -s HUP backend`) oder per `system.reload` über WebSocket (PROTOKOLL.md §3.7). Fehlschlag lässt den alten Stand aktiv, Mehrfachaufrufe sind über `reloadInFlight` abgesichert. **Dabei mitgefixt:** `loadPatch()` hatte ein `await` zwischen dem Zuweisen von `dmxChannels` und `mlFixtures` — beim Start harmlos, beim Reload zur Laufzeit hätte der 40-Hz-Tick einen halb getauschten Patch gesehen. Jetzt werden beide Abfragen zuerst gemacht und dann in einem Rutsch umgeschaltet. Verifiziert ohne Neustart (Prozessstarts 10 → 10): Kanalname in der DB geändert, SIGHUP, neuer Name im laufenden Prozess. | `server.js:640-670, 145` |
| B3.4 | **Keine Authentifizierung, kein TLS.** | **verworfen 2026-08-29** – bewusste Entscheidung, Betriebsnetz gilt als vertrauenswürdig (`PROTOKOLL.md` §10.4). Gilt nur, solange das Pult nicht aus einem fremden Netz erreichbar ist. |
| B3.5 | ~~Art-Net-Feinheiten.~~ **erledigt 2026-08-29** – (a) **Sequence** je Universe 1..255, die 0 wird übersprungen (bedeutet laut Spec „Sequencing aus"); über 318 Pakete verifiziert: lückenlos, Überlauf `255 → 1`, Wert 0 kam nie vor. (b) **ArtPoll/ArtPollReply**: der Socket bindet jetzt auf `ARTNET_PORT` statt auf einen zufälligen Port und antwortet je bespieltem Universe mit einer 239-Byte-Reply (Style 1 = Controller, PortType 0x80, echte IP und MAC). Ist der Port belegt, wird auf einen freien ausgewichen — Senden läuft weiter, nur die Erkennung fällt weg. (c) **ArtSync** opt-in über `ARTNET_SYNC` (Default aus), nach den ArtDMX-Paketen eines Ticks; gemessen 59 ArtDMX zu 59 ArtSync in 1,5 s bei 40 Hz. | `server.js:430-560` |
| B3.6 | **Kein Idle-Sparbetrieb**: 40 Hz Dauersenden auch ohne Änderung. | **verworfen 2026-08-29** – bewusst so; kontinuierliches Senden ist bei DMX das erwartete Verhalten. |

### B4 · Umgebung & Repo

| # | Aufgabe | Bezug |
|---|---|---|
| B4.1 | ~~Native Betriebsart für echte Art-Net-Hardware.~~ **erledigt 2026-08-29** – `npm install` in `backend/` ausgeführt (14 Pakete, `package-lock.json` neu), Startskript `ops/start-native.sh`. Läuft gegen die Docker-DB über `DB_PORT=3307` (D3). **Zwei Portkonflikte auf diesem Rechner:** (a) grandMA3 onPC belegt TCP 8080 mit seinem Web-Remote → nativer WS-Port ist 8090, `LIGHT_WS_PORT` in der `.env` entsprechend gesetzt. (b) Der Art-Net-Socket band 6454 für ArtPoll und hat MA3 den Port **tatsächlich weggenommen** — gemessen: bei mehreren Sockets auf demselben UDP-Port bekommt nur einer die Pakete, MA3 verschwand aus der Bindungsliste und war sofort zurück, als der Prozess endete. Dafür neu: `ARTNET_DISCOVERY=false` bindet einen freien Port statt 6454. | D2 |
| B4.2 | Reset-/Migrationsskript für die Testdatenbank. | **verworfen 2026-08-29** – beim Testen wird die DB einfach neu aufgesetzt (`docker compose down -v`). Die beiden vorhandenen Migrationen in `database/migrations/` sind idempotent und bleiben für die Produktiv-DB nutzbar. |
| B4.3 | ~~`.gitignore` anlegen; `.env` aus der Versionierung nehmen.~~ **erledigt 2026-08-29** – `.gitignore` deckt `node_modules/`, beide `.env` (mit Ausnahmen für die `.env.example`), Logs und Editor-/OS-Dateien ab. `.env` und `backend/.env` waren bereits getrackt und wurden per `git rm --cached` aus dem Index genommen; die Dateien liegen unverändert auf der Platte. **Rest-Risiko:** beide stehen weiterhin in der Historie — aktuell unkritisch (`DB_PASSWORD=CHANGE_ME`), aber sobald dort ein echtes Passwort eingecheckt würde, hilft nur History-Rewriting. | D7 |
| B4.4 | Tests, Lint, CI. | **verworfen 2026-08-29** – bewusst nicht verfolgt. |
