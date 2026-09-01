#!/usr/bin/env bash
# Backend nativ auf dem Host starten, mit der Docker-Testdatenbank.
#
# Warum nativ: aus dem Container erreicht Art-Net das LAN nicht
# (Docker Desktop / WSL2, siehe ANALYSE.md D1/D2). Fuer echte Nodes
# oder fuer Tools auf demselben Rechner muss der Server nativ laufen.
#
# Voraussetzungen:
#   - docker compose up -d db        (Datenbank auf Port 3307)
#   - npm install                    (einmalig in backend/)
#   - docker compose stop backend    (sonst doppelte Art-Net-Ausgabe)
#
# Beenden: Strg+C

set -euo pipefail
cd "$(dirname "$0")/../backend"

# --- Datenbank: die per docker compose veroeffentlichte Testinstanz ---
export DB_HOST=127.0.0.1
export DB_PORT=3307
export DB_USER=gyra
export DB_PASSWORD=gyra
export DB_NAME=lichtsteuerung

# --- WebSocket ---
# 8080 ist auf diesem Rechner von grandMA3 onPC belegt (Web-Remote),
# deshalb 8090. Das Frontend muss denselben Port kennen:
# LIGHT_WS_PORT in der .env im Projektwurzelverzeichnis.
export WS_PORT="${WS_PORT:-8090}"

# --- Art-Net ---
export TICK_HZ=40
export ARTNET_MODE="${ARTNET_MODE:-unicast}"
export ARTNET_HOST="${ARTNET_HOST:-127.0.0.1}"
export ARTNET_UNIVERSE=0

# WICHTIG: nicht auf 6454 lauschen, solange MA3 oder ein Analyzer laeuft.
# Bei mehreren Sockets auf demselben UDP-Port bekommt nur EINER die Pakete -
# der Server wuerde dem anderen Programm den Empfang wegnehmen.
export ARTNET_DISCOVERY="${ARTNET_DISCOVERY:-false}"

echo "Starte Lightserver nativ  ->  WS ws://0.0.0.0:${WS_PORT}, Art-Net an ${ARTNET_HOST}:6454"
exec node server.js
