# Atrium Light

Pult-Weboberflaeche, WebSocket-/Art-Net-Server und Datenbank fuer die
Lichtsteuerung im Atrium.

## Schnellstart (Ubuntu-Server)

Voraussetzung: Docker mit Compose-Plugin.

```bash
git clone git@github.com:lioker-source/gyra-light-control.git
cd gyra-light-control
./start.sh
```

Das war alles. `start.sh` legt bei Bedarf die `.env` an, baut die Images,
startet alles im Hintergrund und nennt am Ende die Adressen.

| Dienst | Adresse |
|---|---|
| Pult (Tablet/Browser) | `http://<Server-IP>:8081` |
| Art-Net-Monitor | `http://<Server-IP>:8082` |
| WebSocket | `ws://<Server-IP>:8080` |
| MariaDB | `<Server-IP>:3307` (`gyra` / `gyra`) |

Weitere Befehle:

```bash
./start.sh logs     # Logs mitlesen
./start.sh stop     # anhalten
./start.sh reset    # Datenbank loeschen und aus schema.sql + seed.test.sql neu aufbauen
```

Die Datenbank wird beim allerersten Start automatisch aus
`database/schema.sql` und `database/seed.test.sql` aufgebaut; danach bleibt
sie im Docker-Volume `db-data` erhalten.

### Art-Net-Ziel

Ohne Aenderung gehen die DMX-Pakete an den mitgelieferten Monitor-Container
(`http://<Server-IP>:8082`) - gut zum Ausprobieren ohne Hardware. Fuer einen
echten Node in der `.env`:

```ini
ARTNET_HOST=192.168.178.40
# oder alle Nodes im Netz erreichen:
ARTNET_MODE=broadcast
ARTNET_BROADCAST_ADDR=192.168.178.255
```

Danach `docker compose up -d backend`.

> Broadcast bleibt im Bridge-Netz von Compose haengen und erreicht keine
> Hardware im LAN. Unicast an die IP des Nodes funktioniert dagegen: das UDP
> wird sauber ins LAN genattet.

### Ports freigeben

Falls auf dem Server eine Firewall laeuft:

```bash
sudo ufw allow 8081/tcp   # Weboberflaeche
sudo ufw allow 8080/tcp   # WebSocket
```

---

## Hintergrund und Details

### Inhalt

- `start.sh` – startet/stoppt die komplette Umgebung (siehe Schnellstart)
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

Aufbau und Adressen siehe Schnellstart oben. Die folgenden Abschnitte
beschreiben die Feinheiten.

### Art-Net-Ziel einstellen

In der `.env`:

```ini
ARTNET_HOST=artnet-monitor     # Default: der Monitor-Container
ARTNET_HOST=192.168.178.40     # echte Hardware im Netz
```

Danach `docker compose up -d backend`.

### Unicast oder Broadcast

Ebenfalls in der `.env`:

```ini
ARTNET_MODE=unicast            # Default: gezielt an ARTNET_HOST
ARTNET_MODE=broadcast          # an alle Nodes im Netz
ARTNET_BROADCAST_ADDR=192.168.178.255   # nur bei broadcast
```

Im Broadcast-Modus wird `ARTNET_HOST` ignoriert; die Pakete gehen an
`ARTNET_BROADCAST_ADDR` (Default `255.255.255.255`). Zuverlässiger als das
globale Broadcast ist die Subnetz-Broadcast-Adresse des Lichtnetzes, nach
Art-Net-Norm also z.B. `2.255.255.255` bzw. `192.168.178.255` im Heimnetz.

Broadcast lohnt sich, wenn mehrere Nodes dieselben Universen bekommen sollen
oder die IP eines Interfaces unbekannt ist. Unicast erzeugt weniger Netzlast
und ist deshalb der Default.

> Im Docker-Setup bleibt ein Broadcast im Bridge-Netz von Compose – der
> Monitor-Container empfängt ihn, echte Hardware im LAN nicht. Dafür das
> Backend direkt auf dem Host betreiben (siehe `ops/`) oder dem Container
> `network_mode: host` geben.

### Art-Net-Tool auf dem Host (Artnetominator, MA3 onPC, …)

Ein Tool, das auf dem Windows-Host lauscht, erreicht man aus dem Container
**nicht** über `127.0.0.1` – das ist die Loopback des Containers, nicht die
des Hosts. Auch Broadcast hilft nicht: unter Docker Desktop (WSL2) endet er
in der VM. Stattdessen gezielt an den Host senden:

```ini
ARTNET_MODE=unicast
ARTNET_HOST=host.docker.internal
```

Docker Desktop stellt diese Pakete auf dem Host so zu, dass sie als von
`127.0.0.1` kommend ankommen – ein auf Loopback eingestelltes Tool sieht sie
also. Lauschen mehrere Programme auf 6454, gewinnt der spezifischere Bind:
ein Tool auf `127.0.0.1` bekommt das Paket vor einem auf `0.0.0.0`.

Solange `ARTNET_HOST` auf den Host zeigt, bekommt der `artnet-monitor`-
Container nichts mehr – für ihn wieder `ARTNET_HOST=artnet-monitor` setzen.

Nach jeder Änderung `docker compose up -d backend`.

### Zugriff vom Tablet

Das Frontend ermittelt den WebSocket-Host automatisch aus der
Browser-Adresszeile – vom Tablet also einfach
`http://<IP-des-Rechners>:8081` aufrufen. Läuft das Backend woanders,
hilft `?ws=<host>[:<port>]` in der URL oder `LIGHT_WS_HOST` in der `.env`.

### Test-Patch

`database/seed.test.sql` enthält den Testaufbau:

| Fixture | Kanäle | Adresse |
|---|---|---|
| 6x Dimmer | je 1 | 1 – 6 |
| RGB 16 1 – LED RGBW | 4 | 7 – 10 |
| RGB 16 2 – LED RGBAW | 5 | 11 – 15 |
| RGB 16 3 – LED RGBAW | 5 | 16 – 20 |
| RGB 16 4 – LED RGBW | 4 | 21 – 24 |
| HW3TW13 1 – Hero Wash 300 TW | 19 | 25 – 43 |

Deckungsgleich mit dem MA3-Testpatch (MA3-Universe 1 = Art-Net-Universe 0).

Datenbank zurücksetzen: `./start.sh reset`

### Konstante Fixture-Kanäle

Kanäle wie Shutter oder Fixture-Mode, die dauerhaft auf einem festen Wert
stehen müssen, tragen ihn in `dmx_channels.fixed_value` (0..255, `NULL` =
normal steuerbar). Der Server hält sie konstant, das Frontend blendet sie
im Programmer aus. Früher war dafür eine feste ID-Liste `[33..39]` im
Servercode verdrahtet.

## Betrieb im Netz (Tablet + Art-Net-Node)

Getestet am 2026-09-01 mit iPad als Pult und einem Mac als Art-Net-Node.

1. In der Root-`.env`:
   - `ARTNET_MODE=broadcast` mit `ARTNET_BROADCAST_ADDR=<Netz>.255` erreicht
     mehrere Empfaenger gleichzeitig (z.B. MA3 lokal **und** einen Monitor im
     LAN). `unicast` mit `ARTNET_HOST=<IP>` geht ebenfalls: UDP aus dem
     Container wird sauber ins LAN genattet, Absender ist die LAN-IP des
     Rechners.
   - `LIGHT_WS_HOST=` leer lassen. Das Tablet nimmt den Host aus der
     Adresszeile.
   - `LIGHT_WS_PORT` bestimmt **beides**: den veroeffentlichten Docker-Port
     und den Port, den die Seite dem Browser nennt.
2. **Port 8080 nicht benutzen, solange grandMA3 onPC laeuft.** Dessen
   Web-Remote bindet `0.0.0.0:8080` und gewinnt gegen Docker gegen jede
   IPv4-Verbindung aus dem Netz — das Tablet landet dann auf MA3 statt auf
   dem Pult und bleibt auf „Verbinde …“ stehen. Über `localhost` faellt das
   nicht auf (siehe ANALYSE.md, D8). Standard ist deshalb 8090.
3. Windows-Firewall: eingehend fuer den Web-Port (8081) und den WS-Port
   (8090) freigeben, sinnvollerweise eingegrenzt auf das eigene Netz und mit
   `-Profile Any` — Windows stuft das Netz nach einem WSL-/Docker-Neustart
   gern wieder als „Oeffentlich“ ein und profilgebundene Regeln greifen dann
   nicht mehr:

   ```powershell
   New-NetFirewallRule -DisplayName 'Atrium Light Web (8081)' -Direction Inbound `
     -Protocol TCP -LocalPort 8081 -Action Allow -Profile Any -RemoteAddress 192.168.178.0/24
   New-NetFirewallRule -DisplayName 'Atrium Light WebSocket (8090)' -Direction Inbound `
     -Protocol TCP -LocalPort 8090 -Action Allow -Profile Any -RemoteAddress 192.168.178.0/24
   ```

4. Aufruf am Tablet: `http://<LAN-IP-des-Rechners>:8081/` — mit `http://`
   davor, sonst versucht Safari HTTPS.

Die Kopfzeile zeigt bei fehlender Verbindung die WS-Adresse an, die das
Geraet anspricht. Das ist der schnellste Weg, einen Portfehler zu erkennen.
