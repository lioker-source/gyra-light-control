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

# Aus der .env lesen, was der Nutzer gesetzt hat; sonst der Default aus
# docker-compose.yml. Auskommentierte Zeilen zaehlen nicht.
conf() {
  local val
  val="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '
')"
  [ -n "$val" ] && echo "$val" || echo "$2"
}

web_port="$(conf WEB_PORT 80)"
ws_port="$(conf LIGHT_WS_PORT 8080)"
mon_port="$(conf MONITOR_PORT 8082)"
db_port="$(conf DB_PORT_HOST 3307)"
db_user="$(conf DB_USER gyra)"

# Port 80 braucht keine Angabe in der Adresszeile.
if [ "$web_port" = "80" ]; then web_url="http://${ip}"; else web_url="http://${ip}:${web_port}"; fi

# Nachpruefen, dass auf dem Web-Port wirklich das Pult antwortet. Ein
# anderer Webserver (Apache auf dem Host, unter Windows auch einer in
# WSL) kann den Port belegen, ohne dass docker compose meckert.
warn=""
if command -v curl >/dev/null 2>&1; then
  if ! curl -sf -m 3 "http://127.0.0.1:${web_port}/" 2>/dev/null | grep -q "Atrium Light"; then
    warn="Auf Port ${web_port} antwortet nicht das Pult, sondern etwas anderes.
  Belegt ein anderer Webserver den Port? Pruefen mit:  sudo ss -ltnp | grep :${web_port}
  Entweder den abschalten oder in der .env einen freien Port setzen: WEB_PORT=8081"
  fi
fi

cat <<INFO

Atrium Light laeuft.

  Pult (Tablet/Browser)   ${web_url}
  Art-Net-Monitor         http://${ip}:${mon_port}
  WebSocket               ws://${ip}:${ws_port}
  MariaDB                 ${ip}:${db_port}   (User ${db_user})

  Logs      ./start.sh logs
  Stoppen   ./start.sh stop

INFO

[ -n "$warn" ] && echo "WARNUNG: $warn" >&2
exit 0
