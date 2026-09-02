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
startet alles im Hintergrund — **HTTPS immer eingeschlossen** — holt das
Wurzelzertifikat aus dem Container und nennt am Ende die Adressen.

| Dienst | Adresse |
|---|---|
| Pult (Tablet/Browser) | `https://<LIGHT_HOST>` |
| Art-Net-Monitor | `http://<Server-IP>:8082` |
| MariaDB | `<Server-IP>:3307` (`gyra` / `gyra`) |
| Pult ohne HTTPS (kein App-Modus) | `http://<Server-IP>` |

HTTPS laeuft mit, weil Android aus dem Pult nur ueber einen sicheren
Ursprung eine echte App baut (Vollbild ohne Adressleiste). Ueber `http`
bleibt es eine Webseite mit Browserleiste — erreichbar, aber nicht als App.

**Einmal in die `.env`:** `LIGHT_HOST` auf einen im LAN aufloesbaren
**Hostnamen** setzen, nicht auf eine IP:

```ini
LIGHT_HOST=atrium.fritz.box
```

Ohne diesen Eintrag laeuft alles ueber die LAN-IP weiter — nur startet die
installierte App dann in Chrome statt im Vollbild, weil Android eine IP in
der Link-Verwaltung nicht zuordnen kann. `start.sh` weist darauf hin.
`LIGHT_ALT_HOST` (die IP) kommt automatisch als Zweitname ins Zertifikat,
damit der alte Weg waehrend der Umstellung erreichbar bleibt.

> `start.sh` prueft nach dem Start, ob unter HTTPS wirklich das Pult
> antwortet und ob der WebSocket mit `101` upgraded, und warnt sonst. Das
> ist kein Luxus: ein zweiter Webserver kann den Port belegen, ohne dass
> `docker compose` etwas meldet — auf dem Windows-Entwicklungsrechner tut
> das ein Apache in WSL.

Weitere Befehle:

```bash
./start.sh logs     # Logs mitlesen
./start.sh stop     # anhalten
./start.sh ca       # Wurzelzertifikat neu ausgeben (fuers Tablet)
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
sudo ufw allow 80/tcp     # Weboberflaeche
sudo ufw allow 8080/tcp   # WebSocket
```

---

## Hintergrund und Details

### Inhalt

- `start.sh` – startet/stoppt die komplette Umgebung (siehe Schnellstart)
- `frontend/manifest.webmanifest`, `frontend/sw.js`, `frontend/app-icons/` – PWA-Teile (Installation als App, Vollbild, Offline-Fallback)
- `frontend/index.php` – Tablet-Weboberfläche (Touch-Pad, Zwei-Finger-Zoom/Dimmer, Controller, Preset-/Programmer-Fader, ML-Positionen, Zoom/Dimmer-Fader)
- `backend/server.js` – WebSocket-, MySQL- und Art-Net-Server mit HTP-Mischung, ML-Steuerung, Positionsspeicherung und robustem Start/Fehlerhandling
- `backend/package.json` – benötigte Node-Abhängigkeiten
- `.env.example` – vollstaendige Konfiguration der Docker-Umgebung; jeder Wert ist optional und entspricht dem Default
- `backend/.env.example` – dasselbe fuer den nativen Betrieb ohne Docker
- `database/schema.sql` – aus dem produktiven Backend rekonstruierte Tabellenstruktur
- `database/export-current-db.sh` – erzeugt auf dem echten Server einen vollständigen Dump inklusive aktueller Presets/Positionen/Patch
- `ops/caddy/` – optionaler HTTPS-Vorbau (Caddy) samt Skript fuer das Wurzelzertifikat; noetig fuer die Installation als App auf dem Tablet
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
`http://<IP-des-Rechners>` aufrufen. Läuft das Backend woanders,
hilft `?ws=<host>[:<port>]` in der URL oder `LIGHT_WS_HOST` in der `.env`.

### Bildschirmgroesse

Das Pult liegt auf einer festen Zeichenflaeche von 1280 x 800 (16:10) und wird
per `transform: scale()` auf den vorhandenen Platz gerechnet (`fitStage()` in
`frontend/app.js`, Buehnenregeln oben in `frontend/app.css`). Grund: welche
CSS-Pixelgroesse Chrome aus der Bildschirmaufloesung ableitet, haengt an der
Geraetedichte - ein OnePlus Pad Lite mit 1920 x 1200 meldet je nach Einstellung
1280 x 800 oder 960 x 600. Der Massstab faengt das ab; die Proportionen und die
physische Groesse der Trefferziele bleiben in beiden Faellen gleich.

Auf abweichenden Seitenverhaeltnissen waechst die Flaeche in der Breite mit
(1280 bis 1600 px), die zusaetzliche Breite bekommt die Positionsspalte. Nur
wenn selbst 1280 px nicht mehr passen, bleibt oben und unten ein Rand.

Wer Masse aendert, aendert sie in diesem 1280-x-800-Raster - nicht in
Prozent oder `vw`/`vh`, die beziehen sich auf den Schirm, nicht auf die Buehne.

### Blackout: ziehen statt druecken

Der Blackout wird geschaltet, indem der Griff ueber die ganze Bahn gezogen
wird — links nach rechts zum Einschalten, rechts nach links zum Aufheben.
Weniger als `BO_SCHWELLE` (80 % des Weges) federt zurueck und schaltet
nichts.

Vorher war es ein Druck von 2 s. Beides sichert gegen den Fehlgriff, das
Ziehen hat aber zwei Vorteile: man sieht waehrend der Geste, wie weit man
ist, und kann bis zuletzt abbrechen, indem man zurueckzieht. Beim Halten
half nur noch loslassen, und ob man lange genug gehalten hatte, sah man erst
am Ergebnis.

Die Ruhelage des Griffs folgt dem Serverzustand, nicht der eigenen Geste —
schaltet ein zweites Geraet, springt der Griff mit.

### Verbindungsfenster

Ein Tippen auf die Verbindungsanzeige links oben oeffnet ein Fenster mit dem,
was sich messen laesst — kein Schmuckstatus: Stand der geladenen Oberflaeche
(aus dem `?v=` der Skriptadresse), Service Worker, Anzeige und Massstab,
Controller, WebSocket-Adresse und -Zustand, Protokollversion beider Seiten,
Alter des letzten Zustands, gemessene Empfangsrate, verworfene Pakete. Vom
Server ueber `diag.request` (PROTOKOLL.md §3.8): Version, Laufzeit, Zahl der
verbundenen Geraete, Takte, Datenbank (per `SELECT 1` wirklich gefragt) und
die Art-Net-Ausgabe mit Ziel, Universe, gesendeten Paketen, Alter des letzten
Pakets und Sendefehlern.

Rot wird ein Wert nur, wenn er ein Problem beschreibt: Socket nicht offen,
Protokollversionen verschieden, Zustand aelter als 3 s, verworfene Pakete,
Datenbank weg, Art-Net stumm oder mit Fehlern.

Drei Schalter: **Seite neu laden**, **Zwischenspeicher leeren** (meldet den
Service Worker ab, loescht die Caches und laedt neu - der Weg, wenn das
Tablet nach einem Update am alten Stand haengt) und **Neu verbinden**
(schliesst den Socket, der bestehende Wiederverbindungspfad uebernimmt).

Nebenbei behoben: Die Kopfzeile zeigte unter "Verbunden" die fest
einprogrammierte Zeichenkette `atrium-light · Universe 0` — Universe 0 stand
dort auch dann, wenn der Patch auf einem anderen laege. Die Zeile ist weg;
die tatsaechliche Adresse steht im Verbindungsfenster.

### Fader: relative Bedienung

Ein Fader folgt der **Bewegung** des Fingers, nicht seiner Position. Anfassen
und ziehen aendert den Wert um den zurueckgelegten Weg, gemessen an der Hoehe
der Bahn; ein Antippen aendert nichts, und erst ab `FADER_SLOP` (6 px) gilt
eine Bewegung ueberhaupt als solche.

Vorher wurde der Wert aus dem Abstand zur Bahnoberkante gerechnet. Das hatte
zwei Fehler zugleich: ein Griff ausserhalb der Bahn - Name, Zahlenzeile,
Rand, Zwischenraum - ergab Werte ueber 1 bzw. unter 0 und liess den Fader
auf 100 % oder 0 % springen. Schraenkte man die Bedienung zur Abhilfe auf die
Bahn ein, blieb jeder Griff daneben wirkungslos, und auf dem Tablet trifft
eine Fingerkuppe oft daneben. Relativ gerechnet faellt beides weg.

Gemessen wird ueber `getBoundingClientRect()`, nicht ueber `clientHeight`:
Zeigerkoordinaten zaehlen in Bildschirmpixeln, die Buehne ist aber skaliert.

Ausnahme: Bei den Presetfadern ist der **Name** allein fuer den langen Druck
da (Umbenennen) und stellt keinen Wert.

### Knopf unter den Presetfadern

Unter jedem belegten Presetfader der Live-Ansicht sitzt ein Knopf, der den
Fader in `BUMP_FADE_MS` (1 s) fahren laesst: steht er auf 0, geht es auf
100 %, sonst auf 0. Die Beschriftung nennt das Ziel (`▲ Voll` / `▼ Aus`) und
folgt auch Aenderungen, die von einem anderen Geraet kommen.

Der Fader schickt die Fahrt in denselben Stufen wie beim Ziehen (`FADER_SEND_MS`,
rund 20 pro Sekunde) und setzt den Endwert exakt. Waehrend der Fahrt gilt der
eigene Wert, sonst schreibt der 10-Hz-Zustand vom Server den aelteren Stand
zurueck. Ein zweiter Druck haelt die Fahrt an, ein Griff an den Fader
ebenfalls - der Finger gewinnt immer.

Leere Plaetze haben keinen Knopf: dort gibt es keinen Fader und nichts zu
fahren. Gilt nur fuer die Presetbank; Wash-Fader und Programmer-Attribute
bekommen ihn bewusst nicht.

### Gestaltungsregeln der Oberflaeche

Die Bildsprache kommt aus `design/` und bleibt: dunkel-warmes Neutral, IBM
Plex Sans/Mono, Amber als einziger Akzent. Dazu ein paar Regeln, die beim
Aendern einzuhalten sind, weil sie sich sonst schleichend aufloesen:

- **Farben nur ueber Tokens.** Die getoenten Untergruende fuer "ausgewaehlt"
  und "Gefahr" heissen `--amberBg` und `--redBg`; rohe Hexwerte gehoeren
  nicht in die Regeln.
- **Rot auf `--redBg` immer als `--redTxt`.** `--red` selbst kommt dort nur
  auf 4.1:1. `--red` bleibt fuer Rahmen und Punkte, wo Textkontrast nicht
  gilt.
- **Textstufen sind gegen den hellsten Untergrund geprueft** (`--amberBg`):
  `--txt2` haelt 5.9:1, `--txt3` 4.8:1. Wer sie abdunkelt, macht das Pult
  aus Armlaenge im dunklen Raum unlesbar.
- **Zerstoerende Aktionen verlangen Halten**, nie einen einfachen Druck -
  siehe `loeschKnopf()`. Alles andere reagiert bewusst schon auf
  `pointerdown`, weil bei Fadern und Pad die Latenz zaehlt.
- **44 px ist die Untergrenze fuer Trefferziele.** Bewusste Ausnahmen:
  Reiter und Grandmaster-Fader (40 px), Patch-Zeilen (42 px, dafuer ueber
  die volle Breite), `Alle`/`Keine` (36 px).

### Controller (Gamepad)

Ein per Bluetooth gekoppelter Controller bedient immer das Moving Light,
unabhaengig von der geoeffneten Seite. Belegung (Standard-Mapping):

| Bedienelement | Wirkung |
|---|---|
| Linker Stick | Pan/Tilt schnell |
| Rechter Stick | Pan/Tilt langsam (beide addieren sich) |
| L1 / R1 gehalten | Dimmer runter / hoch, voller Weg in `GP_DIM_HOLD_SEC` (3 s) |
| L1 / R1 doppelt getippt | Rampe auf Minimum / Maximum in `GP_DIM_TAP_SEC` (1 s) |
| L2 / R2 | Zoom enger / weiter, analog zur Druckstaerke |
| Steuerkreuz | Position 1-4; oben ist 1, dann im Uhrzeigersinn |

Alle Zeiten und Faktoren stehen als `GP_*`-Konstanten oben in
`frontend/app.js`.

Der Controller faehrt mit einer **festen Empfindlichkeit** von
`GP_SENSITIVITY` (25 %) und ist vom Pad-Empfindlichkeits-Fader unberuehrt.
Der Stickweg ist bereits die Dosierung; eine zweite, am Bildschirm
verstellte Skala darueber macht den Controller unberechenbar. Technisch
geht der Wert als optionales Feld `sensitivity` in `ml.move` mit
(PROTOKOLL.md §3.2) — das Touch-Pad laesst es weg und bekommt damit
weiterhin die eingestellte Empfindlichkeit.

Die Kopfzeile zeigt links neben den Reitern, ob der Controller da ist. Zwei
Dinge, die man dabei wissen muss:

- Angezeigt wird, ob **der Browser** das Pad sieht. Ob die Bluetooth-Kopplung
  steht, kann eine Webseite nicht feststellen.
- Die Gamepad-API gibt ein Geraet aus Datenschutzgruenden erst nach dem
  **ersten Tastendruck** preis. Nach dem Neuladen steht dort also
  "nicht verbunden", bis einmal eine Taste gedrueckt wurde. Das ist kein
  Fehler.

Meldet der Browser ein anderes als das Standard-Mapping, steht das in der
Kopfzeile ("fremde Belegung") - die Tastennummern in `GP_B` stimmen dann
nicht und muessen fuer das Geraet angepasst werden.

Pan und Tilt laufen ueber `ml.move`, also ueber eine Geschwindigkeit mit
Totmann-Schalter im Server (PROTOKOLL.md §3.2). Solange ein Stick ausgelenkt
ist, frischt der Client mit `MOVE_HZ` auf; beim Loslassen geht genau eine
Null raus. Dimmer und Zoom fuehrt der Controller waehrend der Bedienung
selbst und uebernimmt danach wieder den Serverwert - sonst schreibt der
10-Hz-Zustand den aelteren Wert zurueck und es zittert.

### Patch als Tabelle

Der Patch steht als Tabelle: Adresse, Name, Bauart, Kanalzahl, Universe.
Sortiert nach Universe und Startadresse, damit Luecken und Ueberschneidungen
untereinander auffallen. Ueberschneidungen faerben die Zeile rot und stehen
zusaetzlich in der Fussleiste — verhindert werden sie nicht, beim Umpatchen
ist eine Ueberschneidung zwischendurch normal.

Angetippt wird die **ganze Zeile**, nicht ein Knopf am Rand. Ein Knopf je
Zeile waere mit seinen 44 px so hoch, dass die Tabelle schon bei elf
Fixtures scrollt; die Zeile ist mit voller Breite ohnehin das groessere
Trefferziel. Der Winkel rechts zeigt an, dass sich etwas oeffnet.

### Programmer: Auswahl, dann Attribute

Der Programmer arbeitet wie ein Pult, nicht wie eine Geraeteliste:

1. Oben die Lampen antippen, die gemeinsam gestellt werden sollen (mehrere
   moeglich, `Alle` / `Keine` als Abkuerzung).
2. Unten erscheinen die Attribute der Auswahl als Fader. Ein Griff schreibt
   den Wert in alle markierten Lampen, die dieses Attribut haben.
3. Naechste Gruppe markieren, wieder stellen. Die Werte der vorherigen
   Gruppe bleiben im Programmer stehen.
4. Zum Schluss `Als Preset speichern`.

Gezeigt wird die **Vereinigung** der Attribute, nicht die Schnittmenge: wer
einen Dimmer und einen LED-Scheinwerfer zusammen markiert, soll den Dimmer
trotzdem stellen koennen. Ein Fader wirkt nur auf die Lampen, die die Rolle
ueberhaupt besitzen.

Stehen die markierten Lampen bei einem Attribut unterschiedlich, ist der
Fader gestrichelt und beschriftet mit `gem.` — der Griff zeigt dann den Wert
der ersten Lampe. Sobald man ihn anfasst, ziehen alle gleich.

Die Reihenfolge der Fader kommt aus `ROLE_ORDER` in `frontend/app.js`, nicht
aus der DMX-Adresse. Nach Adresse sortiert stuende bei gemischter Auswahl
sonst Weiss vor Amber, nur weil die erste Lampe kein Amber hat.

Pan und Tilt haben bewusst keine Fader: die Position kommt aus den
definierten Slots (`POSITION`-Zeile, erscheint sobald ein Moving Light
markiert ist). Ein Preset speichert den Slot als Verweis, nicht als
Kanalwerte — damit bleibt die Position in der Hand von Pad und
Positionsliste.

### Als App auf dem Tablet (PWA)

Das Pult bringt ein Web-App-Manifest (`frontend/manifest.webmanifest`),
Icons (`frontend/app-icons/`) und einen Service Worker (`frontend/sw.js`)
mit. Richtig installiert laeuft es im Vollbild, im Querformat, ohne
Adressleiste und mit eigenem Icon im App-Drawer.

**Das geht nur ueber HTTPS.** Android baut aus einer PWA nur dann eine echte
App (ein *WebAPK*), wenn der Ursprung sicher ist; sonst entsteht bloss eine
Verknuepfung, die in Chrome mit Adressleiste aufgeht. Das Chrome-Flag
`unsafely-treat-insecure-origin-as-secure` reicht dafuer **nicht** — es
erlaubt die Installation, wird aber an das WebAPK nicht vererbt.

Deshalb liegt ein HTTPS-Vorbau bei: Caddy mit einer eigenen lokalen CA,
passend fuer eine LAN-IP, fuer die es kein oeffentliches Zertifikat gibt.

**1. Namen eintragen.** In der `.env` den Namen setzen, unter dem das Tablet
das Pult aufruft — genau diese Adresse muss spaeter in der Adresszeile stehen:

```ini
LIGHT_HOST=atrium.fritz.box
LIGHT_ALT_HOST=192.168.178.110
```

`LIGHT_HOST` sollte ein **Hostname** sein, keine nackte IP. Android behandelt
eine IP in der Link-Verwaltung als nicht zuordenbar — die installierte App
steht dann zwar im App-Drawer, reicht ihre eigene Adresse beim Start aber an
Chrome weiter und geht mit Adressleiste auf. Mit einem Namen faellt das weg.

Der Name muss im LAN aufloesbar sein. Am einfachsten ueber den Router: eine
FritzBox vergibt jedem Geraet automatisch `<geraetename>.fritz.box`, andere
Router haben eine Liste fuer feste DNS-Namen. Zum Pruefen vom Tablet aus
reicht ein Aufruf von `http://<name>/` im Browser.

`LIGHT_ALT_HOST` ist ein zweiter Name — ueblicherweise die LAN-IP —, damit der
bisherige Weg waehrend der Umstellung erreichbar bleibt. Beide Werte muessen
sich unterscheiden; Caddy stellt fuer jeden ein eigenes Zertifikat aus.

**2. Starten.** `./start.sh` bringt HTTPS immer mit hoch, holt das
Wurzelzertifikat aus dem Container und prueft danach, ob die Seite und der
WebSocket ueber HTTPS wirklich antworten:

```bash
./start.sh
```

Von Hand geht auch `docker compose --profile https up -d`; dann muessen
`LIGHT_HOST`, `LIGHT_ALT_HOST` und `LIGHT_SNI` selbst gesetzt sein.

Das Pult liegt dann zusaetzlich auf `https://<LIGHT_HOST>/`. Port 80 behaelt
das Frontend im Klartext; wer die Umleitung http→https auf 80 will, rueckt
das Frontend mit `WEB_PORT=8081` weg und setzt `HTTPS_REDIRECT_PORT=80`.

**3. Wurzelzertifikat aufs Tablet:**

```bash
./ops/caddy/export-ca.sh        # erzeugt atrium-light-ca.crt
```

Die Datei aufs Tablet bringen und dort installieren: *Einstellungen →
Sicherheit → Verschluesselung & Zugangsdaten → Zertifikat installieren →
CA-Zertifikat → Trotzdem installieren*. Android warnt dabei deutlich — das
ist bei einer eigenen CA erwartbar.

**4. Installieren.** Am Tablet `https://<LIGHT_HOST>/` aufrufen (das Schloss
muss zu sein), dann Menue → *App installieren*. Fuer das WebAPK braucht das
Tablet **einmalig Internet**: Chrome laesst die App bei Google bauen. Ohne
Internet entsteht wieder nur eine Verknuepfung.

**5. Chrome-Flag zuruecksetzen.** `chrome://flags/#unsafely-treat-insecure-origin-as-secure`
wieder leeren — es wird nicht mehr gebraucht und verdeckt sonst echte Fehler.

> **`ERR_SSL_PROTOCOL_ERROR` beim Aufruf?** Dann fehlt `default_sni` im
> globalen Block des `Caddyfile`. Beim Aufruf ueber eine IP-Adresse schickt
> der Browser kein SNI mit — das ist per Norm nur fuer Hostnamen vorgesehen.
> Caddy weiss dann nicht, welches Zertifikat es vorlegen soll, und bricht den
> Handshake ab. Dort gehoert deshalb `LIGHT_ALT_HOST` (die IP) hinein, nicht
> der Hostname. Ueber den Hostnamen tritt das nie auf.

Kontrolle: unter `chrome://webapks` muss „Atrium Light" stehen. Ist die Liste
leer, war es nur eine Verknuepfung — dann Schritt 4 mit Internet wiederholen.

> **Die App steht im App-Drawer, oeffnet aber Chrome?** Dann wurde beim
> Installieren `browser` als Anzeigemodus in die WebAPK gebrannt — der Modus
> ist fest und aendert sich nicht durch ein Update des Manifests. Zu sehen
> unter `chrome://webapks` in der Zeile „Display Mode". Abhilfe: App
> deinstallieren, in Chrome die Websitedaten der Adresse loeschen, dann ueber
> den **Hostnamen** neu installieren. Ueber eine nackte IP passiert genau das
> immer wieder.

Der WebSocket laeuft unter HTTPS als `wss://<LIGHT_HOST>/ws` ueber denselben
Proxy. Das ist keine Bequemlichkeit: ein `ws://` von einer `https`-Seite
blockiert der Browser als Mixed Content. `frontend/app.js` waehlt das Schema
automatisch anhand der Seite, an der `.env` ist dafuer nichts zu tun.

Der Service Worker liefert grundsaetzlich *network-first*: ein neu deployter
Stand gewinnt immer, der Cache ist nur der Fallback, wenn der Server nicht
antwortet. Die Bedienung haengt am WebSocket und laeuft am Service Worker
vorbei — offline zeigt das Pult wie gehabt den Offline-Schirm, es wird nichts
aus dem Cache „weiterbedient".

Nach Aenderungen an `app.js`/`app.css` die `VERSION` in `frontend/sw.js`
hochzaehlen; dann raeumt der neue Worker den alten Cache ab und die laufende
App laedt sich einmal neu.

> Stolperstein, falls du eigene Dateien ergaenzt: Apache belegt `/icons/`
> bereits per `Alias` fuer seine Autoindex-Symbole. Ein Verzeichnis
> `frontend/icons/` waere darum von aussen nicht erreichbar — deshalb heisst
> es `frontend/app-icons/`.

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
3. Windows-Firewall: eingehend fuer den Web-Port (80) und den WS-Port
   (8090) freigeben, sinnvollerweise eingegrenzt auf das eigene Netz und mit
   `-Profile Any` — Windows stuft das Netz nach einem WSL-/Docker-Neustart
   gern wieder als „Oeffentlich“ ein und profilgebundene Regeln greifen dann
   nicht mehr:

   ```powershell
   New-NetFirewallRule -DisplayName 'Atrium Light Web (80)' -Direction Inbound `
     -Protocol TCP -LocalPort 80 -Action Allow -Profile Any -RemoteAddress 192.168.178.0/24
   New-NetFirewallRule -DisplayName 'Atrium Light WebSocket (8090)' -Direction Inbound `
     -Protocol TCP -LocalPort 8090 -Action Allow -Profile Any -RemoteAddress 192.168.178.0/24
   ```

4. Aufruf am Tablet: `http://<LAN-IP-des-Rechners>/` — mit `http://`
   davor, sonst versucht Safari HTTPS.

Die Kopfzeile zeigt bei fehlender Verbindung die WS-Adresse an, die das
Geraet anspricht. Das ist der schnellste Weg, einen Portfehler zu erkennen.
