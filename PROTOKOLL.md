# Atrium Light – WebSocket-Protokoll v2 (Entwurf)

Stand: 2026-09-01 · Status: **serverseitig vollständig implementiert**

Die Verbindungssequenz aus §2, die Befehle aus §3 und die Nachrichten aus §4
sind im Backend vorhanden und getestet. Die v1-Namen laufen als Aliase weiter,
bis das neue Frontend steht (§9); `save_ml_position` / `recall_ml_position`
sind bereits entfernt. Ebenso geht neben `patch`/`library`/`state` weiterhin
das alte `init_state` raus, damit das bestehende v1-Frontend bedienbar bleibt —
beides fällt zusammen mit dem Frontend-Neubau weg.

Grundlage für den Frontend-Neubau und für Abschnitt 5/B2 der `ANALYSE.md`.

---

## 1. Grundsätze

**Der Server hält den Zustand, der Client stellt Anträge.**

Das ist die zentrale Änderung gegenüber v1. Heute schickt jeder Tab 20-mal pro
Sekunde seinen kompletten lokalen ML-Zustand (`ml_live` mit Zoom *und* Dimmer),
und wer zuletzt schreibt, gewinnt. Zwei Tablets überschreiben sich damit
dauerhaft gegenseitig; selbst ein einzelner offener Tab nagelt Zoom und Dimmer
auf seinen lokalen Stand fest (Befund A9).

Daraus folgen drei Regeln:

1. **Clients senden Absichten, keine Zustände.** „Dimmer auf 40 %" statt
   „mein gesamter ML-Zustand ist gerade so".
2. **Clients senden nur bei Änderung.** Einzige Ausnahme ist die
   Joystick-Geschwindigkeit (§3.2), die naturgemäß fortlaufend ist — und die
   bekommt dafür einen Totmann-Schalter.
3. **Der Server bestätigt nie einzeln, sondern sendet Zustand.** Jede Änderung
   landet im nächsten `state`-Broadcast an *alle* Clients. Kein `preset_saved`,
   `ml_position_saved`, `ml_position_recalled` mehr — das waren Einzelantworten
   an genau den Client, der ohnehin schon Bescheid wusste.

### Wer hält was

| Zustand | Ort | Persistenz |
|---|---|---|
| Patch (Kanäle, ML-Fixtures) | Server, aus DB | DB |
| Presets + deren Werte | Server, aus DB | DB |
| ML-Positionen (9 Slots) | Server, aus DB | DB |
| Preset-Faderstände | Server, RAM | flüchtig |
| Programmer-Werte | Server, RAM | flüchtig |
| ML-Ist-Zustand (Pan/Tilt/Zoom/Dimmer) | Server, RAM | flüchtig |
| Grandmaster, Blackout | Server, RAM | flüchtig |
| Pad-Sensitivität | Server, aus DB | DB |
| Aktiver Tab, Fader-Optik, Touch-Status | **nur Client** | — |

Flüchtiger Zustand überlebt bewusst einen Client-Disconnect: ein Pult darf nicht
schwarz werden, weil ein Tablet in den Standby geht.

---

## 2. Verbindungsaufbau

Nach dem Öffnen schickt der **Server** ungefragt vier Nachrichten in dieser
Reihenfolge:

```
hello  →  patch  →  library  →  state
```

- `hello` nennt Protokollversion und die `client_id`, die dieser Client bekommt.
- `patch` und `library` sind groß und ändern sich selten.
- `state` ist der erste vollständige Zustands-Snapshot.

Der Client sendet **nichts** zum Aufbau. Passt seine Protokollversion nicht,
schließt er die Verbindung selbst und zeigt es an.

```json
{ "type": "hello", "protocol": 2, "client_id": "c7f3a1", "server_time": 1756470000000 }
```

---

## 3. Client → Server

Alle Nachrichten haben `type`. Unbekannte `type`-Werte beantwortet der Server
mit `error` und ignoriert sie sonst.

### 3.1 Master

```json
{ "type": "master.grandmaster", "value": 0.85 }
{ "type": "master.blackout",    "on": true }
```

`value` ist 0..1. Blackout ist ein eigener Schalter, kein Grandmaster auf 0 —
damit der vorherige Grandmaster-Stand beim Aufheben erhalten bleibt.

### 3.2 Movinglight

```json
{ "type": "ml.move",   "pan_speed": -0.4, "tilt_speed": 0.1 }
{ "type": "ml.goto",   "pan": 0.5, "tilt": 0.5 }
{ "type": "ml.zoom",   "value": 0.7 }
{ "type": "ml.dimmer", "value": 0.4 }
```

`ml.move` ist der einzige fortlaufende Befehl. Er setzt eine
**Geschwindigkeit**, die der Server weiter integriert, bis etwas anderes kommt.

> **Totmann-Schalter:** Bleibt eine gesetzte Geschwindigkeit länger als
> `ML_MOVE_TIMEOUT_MS` (Vorschlag: 400 ms) ohne Auffrischung, setzt der Server
> sie auf 0. Sonst fährt der Kopf weiter, wenn ein Tablet mitten in der
> Bewegung abstürzt oder das WLAN abreißt. Der Client frischt also nur
> **während** einer Pad-Berührung auf (z.B. alle 100 ms) und schickt beim
> Loslassen genau einmal `pan_speed: 0, tilt_speed: 0`.

`ml.goto` bricht eine laufende Positionsfahrt ab, `ml.move` ebenfalls.

**Zoom und Dimmer sind teilbar.** Steht im Programmer oder in einem
hochgezogenen Preset ein Wert für den Zoomkanal, gilt der; sonst führt das
Pad. Der Dimmer bleibt zusätzlich HTP wie der Rest des Pults. Pan und Tilt
haben im Programmer keinen Fader — dafür gibt es die Positionsauswahl.

### 3.3 Presets

```json
{ "type": "preset.fader",  "preset_id": 3, "level": 0.6 }
{ "type": "preset.save",   "preset_id": null, "name": "Warm", "page": 1,
  "fader_index": 4, "channels": [ { "channel_id": 7, "max_value": 1.0 } ] }
{ "type": "preset.update", "preset_id": 3, "name": "Warm hell" }
{ "type": "preset.delete", "preset_id": 3 }
```

`preset.update` ändert **nur** den Namen und lässt die gespeicherten
Kanalwerte in Ruhe — dieselbe Trennung wie `position.update` bei den
Positionen. Sie ist notwendig, weil `preset.save` mit `preset_id` die
`light_preset_values` löscht und neu schreibt: ein blosses Umbenennen über
`preset.save` würde den Inhalt des Presets durch den aktuellen Programmer
ersetzen.

`preset_id: null` legt neu an. Ist der Slot (`page` + `fader_index`) belegt,
antwortet der Server mit `error` und `code: "slot_occupied"` — **überschreiben
ohne Rückfrage gibt es nicht mehr**. Das Frontend fragt nach und schickt dann
`preset.save` mit der bestehenden `preset_id`.

**`channels` ist optional** (Entscheidung §10.2). Fehlt das Feld, speichert der
Server, was gerade im Programmer steht — das gewohnte „Store“ echter Pulte:

```json
{ "type": "preset.save", "preset_id": null, "name": "Aus Programmer",
  "page": 4, "fader_index": 1 }
```

Kanäle mit Wert 0 kommen dabei nicht mit. Wird `channels` mitgeschickt, gilt
ausschliesslich diese Liste — damit bleibt ein Preset aus einer Teilauswahl
möglich, und der Programmer-Stand spielt keine Rolle.

**Die Position steckt als Verweis im Preset**, nicht als Pan/Tilt-Werte:
`preset.save` nimmt `position_slot` entgegen (ohne Angabe die im Programmer
gewählte). Wird der Fader eines solchen Presets von 0 aufgezogen, fährt der
Kopf den Slot mit dessen Fadezeit an — einmalig beim Übergang, nicht bei
jeder Faderbewegung: eine Position ist nicht dimmbar, sie wird ausgelöst.
Damit bleiben Pan/Tilt allein in der Hand von Pad und Positionsliste und
können sich nicht mit einem Preset streiten. `library.positions` nennt unter
`used_by`, welche Presets auf einen Slot zeigen; beim Löschen einer Position
setzt der Server deren `position_slot` auf `null`.

**Speichern aus dem Programmer leert ihn.** Der Look steht danach im Preset;
bliebe er zusätzlich im Programmer stehen, läge er doppelt übereinander. Bei
mitgeschickten `channels` bleibt der Programmer unberührt. Das macht
bewusst der Server: schickte der Client ein eigenes `programmer.clear`
hinterher, könnte es während des noch laufenden Datenbankschreibens greifen
und ein leeres Preset erzeugen.

### 3.4 Programmer

```json
{ "type": "programmer.channel", "channel_id": 12, "value": 0.5 }
{ "type": "programmer.clear" }
{ "type": "programmer.load_preset", "preset_id": 3 }
{ "type": "programmer.position",    "slot": 3 }
```

`programmer.position` wählt die Position, die ein daraus gespeichertes Preset
bekommt (`slot: null` = keine). Der Kopf fährt sie sofort an, damit sichtbar
ist, was gespeichert wird. Der gewählte Slot steht als `programmer_position`
im `state` und gehört zum Programmer wie die Kanalwerte: `programmer.clear`
setzt ihn zurück, `programmer.load_preset` übernimmt ihn aus dem Preset.

`programmer.load_preset` holt ein gespeichertes Preset zum Bearbeiten in den
Programmer. Der Programmer wird dabei **ersetzt**, nicht ergänzt — sonst
mischt sich der vorherige Stand unbemerkt in das Preset, das gleich
zurückgespeichert wird. Der Client schickt nur die Absicht; die Werte kommen
über den nächsten `state`-Broadcast zurück, es gibt also keine Antwort mit
Kanaldaten und die Bibliothek bleibt schlank.

### 3.5 ML-Positionen

```json
{ "type": "position.store",  "slot": 3, "name": "Bühne links", "fade_time_sec": 2.0 }
{ "type": "position.recall", "slot": 3 }
{ "type": "position.update", "slot": 3, "name": "Bühne Mitte", "fade_time_sec": 4.0 }
{ "type": "position.delete", "slot": 3 }
```

`position.store` speichert den **aktuellen** ML-Zustand — der Client schickt
keine Koordinaten mehr mit. Er weiß sie ohnehin nur aus dem letzten `state`,
und damit war v1 anfällig für genau die Rennsituation aus §1.

`position.update` ändert **nur** Name und/oder Fadezeit und lässt Pan/Tilt/Zoom
unberührt (Entscheidung §10.3). Ohne diesen Befehl liesse sich ein Slot nicht
umbenennen und keine Fadezeit korrigieren, ohne den Kopf vorher dorthin zu
fahren. Beide Felder sind einzeln optional, mindestens eines muss gesetzt sein
(sonst `bad_request`). Auf einen leeren Slot angewendet antwortet der Server mit
`not_found` — eine Position ohne Koordinaten kann so nicht entstehen.

### 3.6 Einstellungen

```json
{ "type": "settings.pad_sensitivity", "value": 0.6 }
```

### 3.7 Patch

```json
{ "type": "patch.fixture.create", "name": "RGB 16 5", "fixture_type": "rgbaw",
  "universe": 0, "start_address": 44 }
{ "type": "patch.fixture.update", "id": 12, "name": "RGB 16 2",
  "fixture_type": "rgbaw", "universe": 0, "start_address": 11 }
{ "type": "patch.fixture.delete", "id": 12 }
```

Der Server kennt die Bauarten als Vorlage und legt die Kanäle selbst an;
der Client gibt nur Name, Bauart, Universe und Startadresse vor. `patch`
nennt die verfügbaren Bauarten unter `fixture_types`
(`{type, label, channel_count}`).

**Was mit Presets passiert**, ist die entscheidende Unterscheidung:

| Änderung | Kanäle | Presets |
|---|---|---|
| Name, Universe, Startadresse | bleiben, nur `dmx_address` und Name werden gesetzt | bleiben erhalten |
| Bauart | werden gelöscht und neu angelegt | Werte dieser Kanäle gehen verloren |
| Fixture gelöscht | werden gelöscht | Werte dieser Kanäle gehen verloren |

Presets zeigen auf Kanal-IDs, und `light_preset_values` hängt mit
`ON DELETE CASCADE` an `dmx_channels` — neue Kanäle bedeuten deshalb neue
IDs und verlorene Werte. Deswegen bleiben beim blossen Umadressieren die
Zeilen bestehen und wandern nur. Das Frontend warnt vor einem Bauartwechsel.

Ein `moving_head` wird beim Anlegen zusätzlich in `ml_fixtures` verdrahtet
(Pan/Tilt/Zoom/Dimmer), damit Pad und Positionen sofort greifen.

Adressüberschneidungen werden **nicht** abgelehnt — beim Umpatchen ist eine
Kollision zwischendurch normal. Das Frontend zeigt sie an.

### 3.8 System

```json
{ "type": "system.reload" }
```

Liest Patch, Presets, Positionen und Einstellungen neu aus der Datenbank,
ohne den Prozess neu zu starten. Faderstände und ML-Zustand bleiben erhalten.
Der Server antwortet allen Clients mit `reloaded` und schickt anschließend
`patch` + `library` (in v1: `init_state`) hinterher.

Dasselbe löst **SIGHUP** aus: `docker compose kill -s HUP backend`.

> Achtung beim Betrieb im Container: Node läuft dort als PID 1, und der Kernel
> stellt PID 1 nur Signale zu, für die ein Handler registriert ist. Läuft noch
> eine Version ohne diesen Handler, wird SIGHUP **stillschweigend verworfen** —
> kein Reload, kein Neustart, keine Meldung.

---

## 4. Server → Client

### 4.1 `patch` — selten, groß

```json
{ "type": "patch",
  "fixtures": [
    { "id": 21, "name": "HW3TW13 1", "type": "moving_head",
      "universe": 0, "start_address": 25 }
  ],
  "channels": [
    { "id": 31, "name": "Wash Dimmer", "universe": 0, "dmx_address": 31,
      "channel_group": "ml", "fixture_id": 21, "role": "dimmer",
      "fixed_value": null, "is_intensity": true }
  ],
  "ml_fixtures": [
    { "id": 1, "name": "Hero Wash 300 TW",
      "pan": 19, "pan_fine": 20, "tilt": 21, "tilt_fine": 22,
      "zoom": 24, "dimmer": 25, "pan_invert": true, "tilt_invert": false }
  ] }
```

Neu gegenüber v1: `is_intensity` (§6) und die Invertierungs-Flags (B1.2, heute
als `1 - pan` fest im Code).

**`fixtures` und `fixture_id`/`role`** kamen dazu, damit der Programmer nach
Gerät gruppieren und je Fixture auf- und zuklappen kann. `type` ist eine der
Bauarten `dimmer`, `dimmer_shutter`, `rgbw`, `rgbaw`, `moving_head`; `role`
benennt die Funktion des Kanals im Gerät (`r`, `g`, `b`, `a`, `w`, `dimmer`,
`shutter`, `pan`, `zoom`, `ctc`, …) und ist die Grundlage für die
Beschriftung im Fader.

**`fixed_value` ist ein Startwert, kein Diktat.** Er gilt, solange weder ein
Preset noch der Programmer den Kanal setzt — der Wash leuchtet damit nach dem
Start, ohne dass Shutter und Segmente von Hand hochgezogen werden müssen.
Sobald der Programmer für den Kanal einen Eintrag hat, gewinnt dieser, **auch
wenn er 0 ist**: Licht ausschalten muss möglich bleiben. Früher wurde
`fixed_value` ganz am Ende über alles geschrieben; solche Kanäle waren im
Programmer deshalb unbedienbar und wurden dort ausgeblendet.

### 4.2 `library` — Presets und Positionen

```json
{ "type": "library",
  "presets": [ { "id": 1, "name": "Dimmer Full", "page": 1, "fader_index": 1 } ],
  "positions": [
    { "slot": 1, "name": "Bühne links", "fade_time_sec": 2.0, "occupied": true },
    { "slot": 2, "name": null, "fade_time_sec": null, "occupied": false }
  ] }
```

**Die Positionsliste ist neu.** In v1 wird `ml_positions` nirgends geladen und
nie ausgeliefert (Befund B2.3) — das Frontend konnte Namen und Belegung der
neun Slots gar nicht kennen und hat sie deshalb stur „1"–„9" genannt. Der
Server braucht dafür eine neue `loadPositions()`.

Immer **alle** Slots senden, auch leere, damit das Frontend „belegt/leer"
darstellen kann, ohne zu raten.

### 4.3 `state` — der Arbeitspferd-Broadcast

Geht an **alle** Clients: periodisch mit `STATE_HZ` (Vorschlag: 10 Hz) und
zusätzlich sofort nach jeder Zustandsänderung.

```json
{ "type": "state",
  "seq": 4711,
  "origin": "c7f3a1",
  "ml": { "pan": 0.42, "tilt": 0.5, "zoom": 0.7, "dimmer": 0.4, "fading": false },
  "master": { "grandmaster": 1.0, "blackout": false },
  "preset_levels": { "1": 0.0, "2": 0.6 },
  "programmer": { "12": 0.5 },
  "pad_sensitivity": 0.6 }
```

- `seq` zählt hoch; ältere Pakete verwirft der Client.
- `origin` ist die `client_id`, die die Änderung ausgelöst hat (oder `null` bei
  periodischen Sendungen).
- `ml.fading` sagt, ob gerade eine Positionsfahrt läuft — das Frontend kann
  dann den Pad-Punkt mitziehen lassen und Bedienelemente sperren.
- `preset_levels` und `programmer` enthalten nur Einträge ungleich 0.
- `programmer_position` ist der im Programmer gewählte Positions-Slot
  (`null` = keiner).

### 4.4 `error`

```json
{ "type": "error", "code": "slot_occupied", "message": "Slot 4 auf Seite 1 ist belegt.", "ref": "preset.save" }
```

Maschinenlesbarer `code`, menschenlesbare `message`. v1 hatte nur Freitext.

---

## 5. Rückkopplung vermeiden

Ein Client, der einen Fader zieht, bekommt seinen eigenen Wert 10-mal pro
Sekunde zurück — ohne Gegenmaßnahme springt der Regler unter dem Finger.

**Regel:** Ein Bedienelement, das der Nutzer gerade berührt („aktiv"), ignoriert
eingehende `state`-Werte für genau dieses Element. Beim Loslassen übernimmt es
wieder den Serverwert. `origin` hilft zusätzlich, den eigenen Anstoß zu
erkennen, reicht als alleiniges Kriterium aber nicht — der periodische
Broadcast trägt `origin: null`.

---

## 6. Blackout und Grandmaster brauchen eine Schema-Erweiterung

Beide dürfen **nur Intensitäten** treffen. Ein Blackout, der Pan/Tilt oder den
Fixture-Mode auf 0 zieht, verstellt den Kopf und schaltet womöglich das Gerät
um. Der Server kann heute nicht unterscheiden, welcher Kanal eine Intensität
ist: `channel_group` ist ein Freitextfeld (`dimmer`, `led`, `ml`) und
beschreibt die Zugehörigkeit, nicht die Funktion.

**Vorschlag:** neue Spalte

```sql
ALTER TABLE dmx_channels
  ADD COLUMN is_intensity TINYINT(1) NOT NULL DEFAULT 0 AFTER channel_group;
```

Im Testpatch wären das die Adressen 1–18 (Dimmer + RGB) und 25 (Wash Dimmer) —
**nicht** 27–32, denn die Weiß-Segmente stehen als `fixed_value` konstant und
sind das Leuchtmittel, nicht der Regler.

Anwendung in der Mischkette, nach der HTP-Mischung und vor der DMX-Wandlung:

```
wert_final = is_intensity ? wert * grandmaster * (blackout ? 0 : 1)
                          : wert
```

`fixed_value`-Kanäle bleiben in jedem Fall unangetastet.

---

## 7. Takte und Grenzen

| Größe | Vorschlag | Begründung |
|---|---|---|
| `TICK_HZ` (DMX) | 40 | unverändert |
| `STATE_HZ` (Broadcast) | 10 | reicht fürs Auge, ein Viertel der DMX-Last |
| `ML_MOVE_TIMEOUT_MS` | 400 | Totmann für `ml.move` (§3.2) |
| Client-Auffrischung `ml.move` | ~100 ms | nur während Berührung |
| WS-Heartbeat | `ping` alle 15 s, Timeout 30 s | B3.2 — sonst bleiben tote Verbindungen in `wss.clients` und bekommen jeden Broadcast |

---

## 8. Mehrere Movinglights

v2 behält den **einen globalen ML-Zustand** aus v1 — alles andere wäre in einem
Zug zu viel. Damit das später nicht zum Protokollbruch führt, sind die
`ml.*`-Nachrichten aber schon so geschnitten, dass ein optionales Feld
`fixture_ids: [1, 2]` ergänzt werden kann; fehlt es, gilt der Befehl wie heute
für alle. `patch.ml_fixtures` ist bereits eine Liste.

---

## 9. Migration von v1

| v1 | v2 |
|---|---|
| `init_state` | aufgeteilt in `hello` + `patch` + `library` + `state` |
| `ml_live` (Vollzustand, 20 Hz) | `ml.move` / `ml.goto` / `ml.zoom` / `ml.dimmer` |
| `ml_sensitivity` | `settings.pad_sensitivity` |
| `preset_fader` | `preset.fader` |
| `programmer_channel` | `programmer.channel` |
| `save_preset` | `preset.save` |
| `ml_pos_store` / `ml_pos_recall` | `position.store` / `position.recall` |
| `save_ml_position` / `recall_ml_position` (Legacy) | **entfällt** (B2.6, ~110 Zeilen Duplikat) |
| `preset_saved` | entfällt → `library` + `state` |
| `ml_position_saved` / `ml_position_recalled` | entfällt → `library` + `state` |
| `pad_sensitivity` | entfällt → Feld in `state` |
| `error` (Freitext) | `error` mit `code` |

Neu ohne Vorgänger: `master.grandmaster`, `master.blackout`,
`programmer.clear`, `programmer.load_preset`, `preset.delete`,
`preset.update`, `position.delete`, `position.update`, `library.positions`.

Ein Parallelbetrieb v1/v2 ist nicht vorgesehen — Frontend und Backend werden
zusammen umgestellt.

---

## 10. Entscheidungen

Alle vier am 2026-08-29 / 2026-09-01 entschieden.

1. **Grandmaster auch auf den ML-Dimmer? — ja, einbeziehen.** Über
   `is_intensity` erfasst `applyMaster()` auch den Wash-Dimmer (Adresse 25).
   Auf manchen Pulten ist der Moving-Head-Dimmer bewusst ausgenommen; hier
   nicht — ein Blackout, der den Wash anlässt, wäre im Live-Betrieb eine
   böse Überraschung. Pan/Tilt und die festen Segmentkanäle bleiben
   unberührt.
2. **Programmer-Werte in Presets speichern — beides.** `channels` bleibt der
   explizite, testbare Normalfall und erlaubt eine kuratierte Auswahl; fehlt
   es, friert der Server den Programmer ein (§3.3). Der Client muss den
   Programmer-Inhalt damit nicht spiegeln und zurücksenden — wobei er gegen
   zwischenzeitliche Änderungen laufen könnte.
3. **`position.store` ohne Koordinaten — bleibt so, ergänzt um
   `position.update`.** Koordinaten kommen weiterhin ausschliesslich aus dem
   Serverzustand (verhindert die Rennsituation aus §1). Umbenennen und
   Fadezeit-Korrektur laufen über `position.update` und bewegen den Kopf
   nicht (§3.5).
4. **Authentifizierung — bewusst keine.** Das Betriebsnetz gilt als
   vertrauenswürdig, jeder darin darf das Licht steuern. Damit bleibt `hello`
   der erste Schritt ohne vorgelagerten Handshake.
   *Konsequenz, falls sich das ändert:* Auth gehört vor `hello`, das Protokoll
   müsste dafür in §2 aufgebrochen werden. Ebenso bleibt `ws://` unverschlüsselt
   — wer das Pult über ein fremdes Netz erreichbar macht, muss vorher hier
   nachbessern.
