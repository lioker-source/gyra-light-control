#!/usr/bin/env bash
# Holt das Wurzelzertifikat der lokalen Caddy-CA aus dem Container.
# Diese Datei muss einmalig auf jedes Tablet, das das Pult als App nutzen soll.
#
#   ./ops/caddy/export-ca.sh
#
# Ergebnis: atrium-light-ca.crt im Projektverzeichnis.

set -euo pipefail
cd "$(dirname "$0")/../.."

OUT="atrium-light-ca.crt"
SRC="/data/caddy/pki/authorities/local/root.crt"

if ! docker compose ps --status running --services 2>/dev/null | grep -qx caddy; then
  echo "FEHLER: Der caddy-Container laeuft nicht." >&2
  echo "        Erst starten:  docker compose --profile https up -d" >&2
  exit 1
fi

# Die CA entsteht erst, wenn Caddy das erste Zertifikat ausgestellt hat.
for _ in $(seq 1 20); do
  if docker compose exec -T caddy test -f "$SRC" 2>/dev/null; then break; fi
  sleep 1
done

docker compose exec -T caddy cat "$SRC" > "$OUT" 2>/dev/null || {
  echo "FEHLER: $SRC nicht gefunden. Laeuft Caddy schon lange genug?" >&2
  rm -f "$OUT"
  exit 1
}

[ -s "$OUT" ] || { echo "FEHLER: $OUT ist leer." >&2; rm -f "$OUT"; exit 1; }

echo "-> $OUT geschrieben."
echo
echo "Auf das Tablet bringen (USB, Mail an sich selbst, oder kurz per"
echo "   python3 -m http.server 8000   und http://<Server-IP>:8000/$OUT )."
echo
echo "Dort: Einstellungen -> Sicherheit -> Verschluesselung & Zugangsdaten"
echo "      -> Zertifikat installieren -> CA-Zertifikat -> Trotzdem installieren"
echo
echo "Danach das Chrome-Flag unsafely-treat-insecure-origin-as-secure wieder"
echo "leeren - es wird nicht mehr gebraucht und verdeckt sonst echte Fehler."
