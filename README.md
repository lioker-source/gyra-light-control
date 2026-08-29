# Atrium Light – produktiver Stand

Dieses Paket enthält den zuletzt auffindbaren produktiven Stand der Atrium-Light-Lösung und **nicht** die später erzeugten Standalone-Mockups.

## Inhalt

- `frontend/index.php` – Tablet-Weboberfläche (W3.CSS, Touch-Pad, Zwei-Finger-Zoom/Dimmer, Gamepad, Preset-/Programmer-Fader, ML-Positionsbuttons, Zoom/Dimmer-Fader und Recall-Synchronisierung)
- `backend/server.js` – WebSocket-, MySQL- und Art-Net-Server mit HTP-Mischung, ML-Steuerung, Positionsspeicherung und robustem Start/Fehlerhandling
- `backend/package.json` – benötigte Node-Abhängigkeiten
- `backend/.env.example` – Beispielkonfiguration ohne Passwort
- `database/schema.sql` – aus dem produktiven Backend rekonstruierte Tabellenstruktur
- `database/export-current-db.sh` – erzeugt auf dem echten Server einen vollständigen Dump inklusive aktueller Presets/Positionen/Patch
- `ops/ecosystem.config.js` – optionale PM2-Konfiguration
- `ops/lightserver.service.example` – alternative systemd-Unit

## Wichtiger Hinweis zur Datenbank

Ein echter aktueller SQL-Dump der laufenden Produktivdatenbank lag im Gesprächs-/Dateibestand nicht vor. `schema.sql` bildet deshalb die vom produktiven Code benötigte Struktur ab, enthält aber **bewusst keine erfundenen Produktionsdaten**.

Um das Paket wirklich vollständig inklusive Ist-Daten zu machen, auf `atriumlight` ausführen:

```bash
cd <Verzeichnis-mit-export-current-db.sh>
./export-current-db.sh
```

Die erzeugte `atrium-light-production-data.sql` enthält dann auch den realen DMX-Patch, Presets, ML-Positionen und Einstellungen.

## Backend installieren

```bash
cd backend
npm install --omit=dev
cp .env.example .env
nano .env
node --check server.js
node server.js
```

Im produktiven Betrieb kann der bereits eingerichtete PM2-Autostart weiterverwendet werden.

## Pfade aus dem bisherigen System

Das Backend lief unter `/opt/lightserver/server.js`. Das Frontend wird über PHP/Apache ausgeliefert und ermittelt die Server-IP per `$_SERVER['SERVER_ADDR']`.

---

## Lokale Testumgebung (Docker)

Benötigt nur Docker – kein lokales PHP, Node oder MariaDB.

```bash
cp .env.example .env      # ggf. ARTNET_HOST anpassen
docker compose up --build
```

| Dienst | Adresse | Zweck |
|---|---|---|
| Frontend | http://localhost:8081 | die Tablet-Oberfläche |
| Art-Net-Monitor | http://localhost:8082 | zeigt die gesendeten DMX-Werte live – Ersatz für echte Hardware |
| Backend (WebSocket) | ws://localhost:8080 | |
| MariaDB | localhost:3307 | User `gyra` / Passwort `gyra` |

Die Datenbank wird beim ersten Start automatisch aus `database/schema.sql`
und `database/seed.test.sql` aufgebaut.

### Art-Net-Ziel einstellen

In der `.env`:

```ini
ARTNET_HOST=artnet-monitor     # Default: der Monitor-Container
ARTNET_HOST=192.168.178.40     # echte Hardware im Netz
```

Danach `docker compose up -d backend`.

### Zugriff vom Tablet

Das Frontend ermittelt den WebSocket-Host automatisch aus der
Browser-Adresszeile – vom Tablet also einfach
`http://<IP-des-Rechners>:8081` aufrufen. Läuft das Backend woanders,
hilft `?ws=<host>[:<port>]` in der URL oder `LIGHT_WS_HOST` in der `.env`.

### Test-Patch

`database/seed.test.sql` enthält den Testaufbau:

| Fixture | Kanäle | Adresse |
|---|---|---|
| Halogen-Dimmer | 1 | 1 |
| RGBA LED-Par | 4 | 11 |
| Hero Spot 300 TW | 19 | 21 |

> Die Kanalbelegung des Hero Spot 300 TW ist **geraten** (typisches
> Moving-Head-TW-Layout) und muss beim echten Patchen anhand des
> Handbuchs korrigiert werden.

Datenbank zurücksetzen: `docker compose down -v && docker compose up --build`

### Konstante Fixture-Kanäle

Kanäle wie Shutter oder Fixture-Mode, die dauerhaft auf einem festen Wert
stehen müssen, tragen ihn in `dmx_channels.fixed_value` (0..255, `NULL` =
normal steuerbar). Der Server hält sie konstant, das Frontend blendet sie
im Programmer aus. Früher war dafür eine feste ID-Liste `[33..39]` im
Servercode verdrahtet.
