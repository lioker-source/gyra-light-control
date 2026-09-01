#!/usr/bin/env bash
# Atrium Light starten - ein Befehl, keine Vorbereitung.
#
#   ./start.sh            starten (baut beim ersten Mal)
#   ./start.sh stop       anhalten
#   ./start.sh logs       Logs mitlesen
#   ./start.sh reset      Datenbank loeschen und neu aufbauen
#
# Voraussetzung: Docker mit Compose-Plugin.

set -euo pipefail
cd "$(dirname "$0")"

die() { echo "FEHLER: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || die "Das Docker-Compose-Plugin fehlt (docker-compose-plugin installieren)."

# Ohne Root-Rechte laeuft docker nur, wenn der Nutzer in der Gruppe docker ist.
if ! docker info >/dev/null 2>&1; then
  die "Kein Zugriff auf den Docker-Daemon. Entweder mit sudo starten oder:
       sudo usermod -aG docker \$USER   (danach neu anmelden)"
fi

# .env ist optional: docker-compose.yml hat fuer alles Defaults.
# Sie anzulegen macht das spaetere Anpassen (Art-Net-Ziel) aber einfacher.
if [ ! -f .env ]; then
  cp .env.example .env
  echo "-> .env aus .env.example angelegt (Defaults: Art-Net geht an den Monitor-Container)."
fi

cmd="${1:-up}"
case "$cmd" in
  stop|down)
    docker compose down
    exit 0
    ;;
  logs)
    docker compose logs -f
    exit 0
    ;;
  reset)
    echo "Datenbank wird geloescht und aus schema.sql + seed.test.sql neu aufgebaut."
    docker compose down -v
    ;;
  up)
    ;;
  *)
    die "Unbekannter Befehl '$cmd'. Erlaubt: up, stop, logs, reset."
    ;;
esac

docker compose up -d --build

# Auf das Backend warten, damit die Ausgabe nicht luegt.
echo -n "Warte auf die Dienste "
for _ in $(seq 1 60); do
  if docker compose ps --status running --services 2>/dev/null | grep -q '^backend$'; then
    break
  fi
  echo -n "."
  sleep 1
done
echo

ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -n "$ip" ] || ip="localhost"
ws_port="$(grep -E '^LIGHT_WS_PORT=' .env 2>/dev/null | cut -d= -f2)"
[ -n "$ws_port" ] || ws_port=8080

cat <<INFO

Atrium Light laeuft.

  Pult (Tablet/Browser)   http://${ip}:8081
  Art-Net-Monitor         http://${ip}:8082
  WebSocket               ws://${ip}:${ws_port}
  MariaDB                 ${ip}:3307   (gyra / gyra)

  Logs      ./start.sh logs
  Stoppen   ./start.sh stop

INFO
