#!/usr/bin/env bash
# Atrium Light starten - ein Befehl, keine Vorbereitung.
#
#   ./start.sh            starten (baut beim ersten Mal)
#   ./start.sh stop       anhalten
#   ./start.sh logs       Logs mitlesen
#   ./start.sh ca         Wurzelzertifikat neu ausgeben (fuers Tablet)
#   ./start.sh reset      Datenbank loeschen und neu aufbauen
#
# HTTPS laeuft immer mit. Grund: Android baut aus dem Pult nur ueber einen
# sicheren Ursprung eine echte App (WebAPK, Vollbild ohne Adressleiste).
# Ueber http bleibt es eine Webseite mit Browserleiste. Das Zertifikat
# stellt eine lokale CA im caddy-Container aus - die muss einmal aufs Tablet.
#
# Voraussetzung: Docker mit Compose-Plugin.

set -euo pipefail
cd "$(dirname "$0")"

die() { echo "FEHLER: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "docker ist nicht installiert."
docker compose version >/dev/null 2>&1 || die "Das Docker-Compose-Plugin fehlt (docker-compose-plugin installieren)."

if ! docker info >/dev/null 2>&1; then
  die "Kein Zugriff auf den Docker-Daemon. Entweder mit sudo starten oder:
       sudo usermod -aG docker \$USER   (danach neu anmelden)"
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "-> .env aus .env.example angelegt (Defaults: Art-Net geht an den Monitor-Container)."
fi

# Aus der .env lesen; auskommentierte Zeilen zaehlen nicht.
conf() {
  local val
  val="$(grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r')"
  [ -n "$val" ] && echo "$val" || echo "$2"
}

# Erste LAN-Adresse des Rechners.
lan_ip() {
  local ip=""
  if command -v hostname >/dev/null 2>&1; then
    ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
  fi
  if [ -z "$ip" ] && command -v ipconfig >/dev/null 2>&1; then   # macOS
    ip="$(ipconfig getifaddr en0 2>/dev/null || true)"
  fi
  [ -n "$ip" ] && echo "$ip" || echo "127.0.0.1"
}

# Compose immer mit dem https-Profil, sonst fehlt der caddy-Container.
dc() { docker compose --profile https "$@"; }

cmd="${1:-up}"
case "$cmd" in
  stop|down) dc down; exit 0 ;;
  logs)      dc logs -f; exit 0 ;;
  ca)        exec ./ops/caddy/export-ca.sh ;;
  reset)
    echo "Datenbank wird geloescht und aus schema.sql + seed.test.sql neu aufgebaut."
    dc down -v
    ;;
  up) ;;
  *) die "Unbekannter Befehl '$cmd'. Erlaubt: up, stop, logs, ca, reset." ;;
esac

ip="$(lan_ip)"

# --- Namen festlegen ---------------------------------------------------
#
# LIGHT_HOST ist der Name, den das Tablet aufruft, und muss im Zertifikat
# stehen. Ein Hostname ist einer nackten IP vorzuziehen: Android kann eine IP
# in der Link-Verwaltung nicht zuordnen, die installierte App gibt ihre
# Adresse dann beim Start an Chrome ab und geht mit Adressleiste auf.
light_host="$(conf LIGHT_HOST "")"
light_alt="$(conf LIGHT_ALT_HOST "")"
host_warnung=""

if [ -z "$light_host" ]; then
  light_host="$ip"
  host_warnung="LIGHT_HOST ist nicht gesetzt - es laeuft auf die IP ${ip}.
  HTTPS funktioniert damit, die App startet auf dem Tablet aber im Browser
  statt im Vollbild. Abhilfe: dem Server im Router einen Namen geben
  (FritzBox: <geraetename>.fritz.box) und in die .env eintragen:
      LIGHT_HOST=atrium.fritz.box"
fi

# Zweiter Name im selben Zertifikat, damit der Zugriff ueber die IP
# erreichbar bleibt. Caddy lehnt doppelte Adressen ab.
if [ -z "$light_alt" ] || [ "$light_alt" = "$light_host" ]; then
  if [ "$light_host" = "$ip" ]; then light_alt="127.0.0.1"; else light_alt="$ip"; fi
fi

https_port="$(conf HTTPS_PORT 443)"
web_port="$(conf WEB_PORT 80)"
mon_port="$(conf MONITOR_PORT 8082)"
db_port="$(conf DB_PORT_HOST 3307)"
db_user="$(conf DB_USER gyra)"

# Zertifikat fuer Zugriffe ohne SNI: das ist immer der Name, der eine IP ist.
# Ist LIGHT_HOST selbst eine IP, gehoert sie hierhin - sonst der Zweitname.
ist_ip() { [[ "$1" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; }
if ist_ip "$light_host"; then light_sni="$light_host"; else light_sni="$light_alt"; fi

export LIGHT_HOST="$light_host" LIGHT_ALT_HOST="$light_alt" LIGHT_SNI="$light_sni"

# --- Starten -----------------------------------------------------------
dc up -d --build

echo -n "Warte auf die Dienste "
for _ in $(seq 1 60); do
  laufend="$(dc ps --status running --services 2>/dev/null || true)"
  if echo "$laufend" | grep -qx backend && echo "$laufend" | grep -qx caddy; then break; fi
  echo -n "."
  sleep 1
done
echo

# --- Wurzelzertifikat bereitlegen --------------------------------------
ca_datei="atrium-light-ca.crt"
if ./ops/caddy/export-ca.sh >/dev/null 2>&1; then
  ca_hinweis="$(pwd)/${ca_datei}"
else
  ca_hinweis=""
fi

# --- Nachpruefen, dass HTTPS wirklich antwortet ------------------------
#
# Ueber --resolve auf 127.0.0.1, damit die Pruefung nicht daran haengt, ob
# der Server seinen eigenen Namen aufloesen kann - das Tablet tut das.
if [ "$https_port" = "443" ]; then url="https://${light_host}"; else url="https://${light_host}:${https_port}"; fi
if [ "$web_port" = "80" ]; then web_url="http://${ip}"; else web_url="http://${ip}:${web_port}"; fi

warn=""
if command -v curl >/dev/null 2>&1 && [ -f "$ca_datei" ]; then
  aufl="--resolve ${light_host}:${https_port}:127.0.0.1"
  if ! curl -sf -m 6 --cacert "$ca_datei" $aufl "${url}/" 2>/dev/null | grep -q "Atrium Light"; then
    warn="Auf ${url} antwortet nicht das Pult.
  Laeuft dort etwas anderes?  sudo ss -ltnp | grep :${https_port}"
  else
    code="$(curl -s -o /dev/null -w '%{http_code}' -m 3 --http1.1 --cacert "$ca_datei" $aufl \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
      -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "${url}/ws" 2>/dev/null || true)"
    [ "$code" = "101" ] || warn="Die Seite laedt, aber der WebSocket unter ${url}/ws antwortet mit ${code:-nichts} statt 101.
  Ohne ihn bleibt das Pult ohne Verbindung."
  fi
fi

# Loest der Name im Netz auf? Nur ein Hinweis - das Tablet fragt den Router,
# nicht diesen Rechner.
namens_hinweis=""
if [ "$light_host" != "$ip" ] && [ "$light_host" != "127.0.0.1" ]; then
  if command -v getent >/dev/null 2>&1; then
    getent hosts "$light_host" >/dev/null 2>&1 || namens_hinweis="ja"
  elif command -v ping >/dev/null 2>&1; then
    ping -c1 "$light_host" >/dev/null 2>&1 || namens_hinweis="ja"
  fi
fi

cat <<INFO

Atrium Light laeuft.

  Pult (Tablet/Browser)   ${url}
  Art-Net-Monitor         http://${ip}:${mon_port}
  MariaDB                 ${ip}:${db_port}   (User ${db_user})

  Ohne HTTPS erreichbar   ${web_url}   (kein App-Modus)
  Zweitname im Zertifikat ${light_alt}

  Logs      ./start.sh logs
  Stoppen   ./start.sh stop

INFO

if [ -n "$ca_hinweis" ]; then
cat <<INFO
Einmalig pro Tablet, sonst meldet Chrome ein unsicheres Zertifikat:

  1. ${ca_datei} auf das Tablet kopieren (USB, Mail, Freigabe).
     ${ca_hinweis}
  2. Einstellungen -> Sicherheit -> Verschluesselung -> Zertifikat installieren
     -> CA-Zertifikat -> Datei waehlen.
  3. ${url} aufrufen, Menue -> App installieren.
     Das Tablet braucht dabei kurz Internet: Android laesst die App bei
     Google praegen. Ohne Internet entsteht nur eine Verknuepfung.

INFO
fi

[ -n "$namens_hinweis" ] && echo "HINWEIS: '${light_host}' laesst sich von diesem Rechner nicht aufloesen.
  Wenn das Tablet den Namen kennt, ist das egal - sonst im Router eintragen." >&2
[ -n "$host_warnung" ] && echo "HINWEIS: $host_warnung" >&2
[ -n "$warn" ] && echo "WARNUNG: $warn" >&2
exit 0
