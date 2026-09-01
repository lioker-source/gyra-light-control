#!/usr/bin/env node
'use strict';

/**
 * Atrium Light Server
 * - WebSocket-Server für Tablet-UI
 * - MySQL für Patch, Presets, ML-Positionen, Settings
 * - HTP-Mischung für Szenenkanäle
 * - Movinglight-Steuerung (Pan/Tilt/Zoom/Dimmer)
 * - DMX/Art-Net-Ausgabe
 */

require('dotenv').config();
const WebSocket = require('ws');
const mysql = require('mysql2/promise');
const dgram = require('dgram');
const crypto = require('crypto');
const os = require('os');

// --------------------------------------------------------
// Globale Error-Handler für maximale Robustheit
// --------------------------------------------------------

process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  // absichtlich KEIN process.exit() – Prozess läuft weiter,
  // Supervisor wie pm2/systemd kümmert sich im Worst Case.
});

// Konfiguration neu laden, ohne Neustart:  docker compose kill -s HUP backend
process.on('SIGHUP', () => {
  if (!pool) return;
  reloadAll('SIGHUP').catch(err => console.error('[RELOAD] Fehler:', err));
});

process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // auch hier kein process.exit()
});

// Debug-Flags
const DEBUG_WS_IN  = process.env.DEBUG_WS_IN === 'true';   // eingehende WS-Messages loggen
const DEBUG_TICKS  = process.env.DEBUG_TICKS === 'true';   // DMX-Ticks grob loggen
const DEBUG_ERRORS = process.env.DEBUG_ERRORS !== 'false';


/* --------------------------------------------------------
 * Utility
 * ------------------------------------------------------*/

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

/* --------------------------------------------------------
 * Konfiguration
 * ------------------------------------------------------*/

const DB_HOST = process.env.DB_HOST || '127.0.0.1';
const DB_PORT = Number(process.env.DB_PORT || 3306);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'lichtsteuerung';

const WS_PORT = Number(process.env.WS_PORT || 8080);
const TICK_HZ = Number(process.env.TICK_HZ || 40);

const ARTNET_HOST = process.env.ARTNET_HOST || '127.0.0.1';
const ARTNET_UNIVERSE_DEFAULT = Number(process.env.ARTNET_UNIVERSE || 0);
const ARTNET_PORT = Number(process.env.ARTNET_PORT || 6454);

// Ausgabe-Modus: 'unicast' (gezielt an ARTNET_HOST) oder 'broadcast'.
const ARTNET_MODE = String(process.env.ARTNET_MODE || 'unicast').trim().toLowerCase();
const ARTNET_BROADCAST = ARTNET_MODE === 'broadcast';

if (ARTNET_MODE !== 'unicast' && ARTNET_MODE !== 'broadcast') {
  console.warn('[ARTNET] Unbekannter ARTNET_MODE "' + ARTNET_MODE + '" - falle auf Unicast zurück.');
}

// Broadcast-Ziel. Besser als 255.255.255.255 ist meist die Subnetz-Broadcast-
// Adresse des Lichtnetzes (z.B. 192.168.178.255 oder nach Art-Net-Norm
// 2.255.255.255), weil manche Interfaces das globale Broadcast verwerfen.
const ARTNET_BROADCAST_ADDR = process.env.ARTNET_BROADCAST_ADDR || '255.255.255.255';

// Tatsächliche Zieladresse der ArtDMX-Pakete.
const ARTNET_TARGET = ARTNET_BROADCAST ? ARTNET_BROADCAST_ADDR : ARTNET_HOST;

// ArtSync nach den ArtDMX-Paketen eines Ticks (B3.5). Bewusst opt-in:
// Nodes im Sync-Modus geben erst nach dem ArtSync aus. Bleibt es aus,
// frieren sie fuer rund 4 Sekunden ein, bevor sie zurueckfallen.
const ARTNET_SYNC = process.env.ARTNET_SYNC === 'true';

// Auf ARTNET_PORT lauschen, um ArtPoll zu beantworten. Ausschalten, wenn
// auf demselben Rechner schon eine Konsole oder ein Analyzer auf 6454
// hoert: bei mehreren Sockets auf demselben Port bekommt nur EINER die
// Pakete - wir wuerden dem anderen Programm sonst den Empfang wegnehmen.
const ARTNET_DISCOVERY = process.env.ARTNET_DISCOVERY !== 'false';

// Kennung in der ArtPollReply.
const ARTNET_SHORT_NAME = (process.env.ARTNET_SHORT_NAME || 'AtriumLight').slice(0, 17);
const ARTNET_LONG_NAME  = (process.env.ARTNET_LONG_NAME  || 'Atrium Light Server').slice(0, 63);

// Art-Net-OpCodes
const OP_POLL       = 0x2000;
const OP_POLL_REPLY = 0x2100;
const OP_DMX        = 0x5000;
const OP_SYNC       = 0x5200;

const DMX_UNIVERSE_SIZE = 512;

// Laufende Sequence je Universe. 0 bedeutet laut Spec "Sequencing aus",
// deshalb laeuft der Zaehler von 1 bis 255 und ueberspringt die 0.
const artnetSequence = new Map();
let artnetSocket = null;

// Default-Pad-Sensitivität (Frontend-Skala 0.1..1.0)
const DEFAULT_PAD_SENSITIVITY = Number(process.env.PAD_SENSITIVITY || 1.0);


/* --------------------------------------------------------
 * Globale State-Objekte
 * ------------------------------------------------------*/

// Patch / DB-Strukturen
let dmxChannels = [];          // Liste aller DMX-Kanäle
let channelById = new Map();   // channel_id -> channel-Objekt (wird beim Reload getauscht)
let mlFixtures = [];           // Liste aller Movinglights

let presets = new Map();       // preset_id -> { meta, values: Map(channel_id -> max_value) }
let mlPositions = new Map();   // button_index -> Zeile aus ml_positions

// Anzahl der Positions-Slots im UI. Leere Slots werden bewusst mit
// ausgeliefert, damit das Frontend "belegt/leer" zeigen kann, ohne zu raten.
const POSITION_SLOT_COUNT = Number(process.env.POSITION_SLOT_COUNT || 9);

// Fadezeit, wenn beim Speichern keine mitgeschickt wird.
const DEFAULT_POSITION_FADE_SEC = Number(process.env.POSITION_FADE_SEC || 1.0);

// Takt des Zustands-Broadcasts an alle Clients (PROTOKOLL.md §4.3, §7).
const STATE_HZ = Number(process.env.STATE_HZ || 10);

// Protokollversion (PROTOKOLL.md §2). Passt sie beim Client nicht,
// schliesst er die Verbindung selbst.
const PROTOCOL_VERSION = 2;
// Auch ohne Änderung mindestens so oft senden - dient zugleich als Lebenszeichen.
const STATE_KEEPALIVE_MS = Number(process.env.STATE_KEEPALIVE_MS || 1000);

// WS-Heartbeat (PROTOKOLL.md §7). Ohne ihn bleiben halb tote Verbindungen
// in wss.clients stehen und bekommen jeden state-Broadcast.
const WS_PING_INTERVAL_MS = Number(process.env.WS_PING_INTERVAL_MS || 15000);

// Runtime-States
const presetFaderLevels = new Map();  // preset_id -> 0..1
const programmerValues = new Map();   // channel_id -> 0..1 (Programmier-Tab)
const outputChannels = new Map();     // channel_id -> 0..1 (gemischtes Ergebnis)

// Movinglight-Gesamtzustand (logische Steuerung für ALLE ML gleicher Bauart)
const mlState = {
  pan: 0.5,    // 0..1
  tilt: 0.5,   // 0..1
  zoom: 0.5,   // 0..1
  dimmer: 0.0  // 0..1
};
let mlDimmerTarget = 0.0;

// Master-Sektion (PROTOKOLL.md §3.1). Die Bedienung dazu kommt mit B2.4;
// hier stehen sie schon, damit die state-Nachricht ihre endgültige Form hat.
let grandmaster = 1.0;
let blackout = false;

// Zustands-Broadcast
let stateSeq = 0;
let stateDirty = true;
let stateOrigin = null;
let lastStateSentTs = 0;


// Joystick-Geschwindigkeiten (−1..+1)
let mlPanSpeed  = 0;  // −1..+1
let mlTiltSpeed = 0;  // −1..+1
let mlMoveLastTs = 0; // Zeitpunkt der letzten Geschwindigkeitsvorgabe

// Pad-Sensitivität (Frontend-Skala 0.1..1.0, beeinflusst die vom Client geschickten Speeds)
let padSensitivity = DEFAULT_PAD_SENSITIVITY;

// Parameter für Joystick-Verhalten
const JOYSTICK_FULL_RANGE_SEC = Number(process.env.JOY_FULL_RANGE_SEC || 2.0);
// z.B. 2.0 ⇒ bei Vollauslenkung braucht er ca. 2s für 0→1
const JOYSTICK_DEADZONE = 0.05;

// Totmann-Schalter fuer ml.move (PROTOKOLL.md §3.2). Bleibt eine gesetzte
// Geschwindigkeit ohne Auffrischung, wird sie auf 0 gezogen - sonst faehrt
// der Kopf weiter, wenn ein Tablet mitten in der Bewegung abstuerzt.
const ML_MOVE_TIMEOUT_MS = Number(process.env.ML_MOVE_TIMEOUT_MS || 400);

// Zeitkonstante der Dimmer-Glättung (Sekunden bis nahe am Zielwert).
const DIMMER_SMOOTHING_SEC = 0.12;
// Ein halber DMX-Schritt. Darunter ist die Differenz am Gerät unsichtbar,
// der Wert würde sein Ziel aber nie exakt erreichen.
const DIMMER_EPSILON = 1 / 512;

// Aktiver Fade zu einer gespeicherten ML-Position
let mlPositionFade = null; // { from, target: {pan,tilt,zoom}, duration, t }

// WebSocket
let wss;

// DB-Pool
let pool;

/* --------------------------------------------------------
 * DB-Ladefunktionen
 * ------------------------------------------------------*/

/**
 * Patch laden (DMX-Kanäle, ML-Fixtures).
 * Wird nur beim Start aufgerufen (oder explizit, wenn du später Patch-Releases einbaust).
 */
async function loadPatch() {
  const conn = await pool.getConnection();
  try {
    // Erst beide Abfragen, dann in einem Rutsch umschalten.
    // Beim Reload zur Laufzeit (reloadAll) laeuft der 40-Hz-Tick weiter;
    // ein await zwischen den Zuweisungen wuerde ihm einen halb
    // getauschten Patch zeigen.
    const [channels] = await conn.query(
      'SELECT * FROM dmx_channels ORDER BY sort_order, id'
    );
    const [ml] = await conn.query(
      'SELECT * FROM ml_fixtures WHERE active = 1 ORDER BY sort_order, id'
    );

    const newChannelById = new Map();
    for (const ch of channels) {
      newChannelById.set(ch.id, ch);
    }

    dmxChannels = channels;
    channelById = newChannelById;
    mlFixtures = ml;

    console.log(`[INIT] Loaded ${dmxChannels.length} DMX channels, ${mlFixtures.length} ML fixtures.`);
  } finally {
    conn.release();
  }
}

/**
 * Presets laden (light_presets & light_preset_values).
 * Kann beliebig oft aufgerufen werden, ohne Fader-Level zu verlieren.
 * max_value wird dabei auf 0..1 normiert:
 *  - Werte >1 werden als 0..255 interpretiert und durch 255 geteilt.
 *  - Werte 0..1 bleiben unverändert.
 */
async function loadPresets() {
  const conn = await pool.getConnection();
  try {
    const [presetRows] = await conn.query(
      'SELECT * FROM light_presets WHERE active = 1 ORDER BY page, fader_index, id'
    );
    const [presetValueRows] = await conn.query(
      'SELECT * FROM light_preset_values'
    );

    const newPresets = new Map();
    const newPresetFaderLevels = new Map();

    // Metadaten aufbauen, alte Fader-Level (falls vorhanden) übernehmen
    for (const p of presetRows) {
      newPresets.set(p.id, {
        meta: p,
        values: new Map()
      });

      const existingLevel = presetFaderLevels.get(p.id);
      newPresetFaderLevels.set(p.id, existingLevel != null ? existingLevel : 0);
    }

    // Werte zuordnen, max_value → 0..1 normalisieren
    for (const row of presetValueRows) {
      const p = newPresets.get(row.preset_id);
      if (!p) continue;

      let raw = row.max_value;
      if (raw == null) continue;

      let norm;
      if (raw > 1) {
        norm = raw / 255.0;
      } else {
        norm = raw;
      }

      norm = clamp(norm, 0, 1);
      p.values.set(row.channel_id, norm);
    }

    // Globale Maps aktualisieren
    presets.clear();
    for (const [id, p] of newPresets) {
      presets.set(id, p);
    }

    presetFaderLevels.clear();
    for (const [id, lvl] of newPresetFaderLevels) {
      presetFaderLevels.set(id, lvl);
    }

    console.log(`[INIT] Loaded ${presets.size} presets.`);
  } finally {
    conn.release();
  }
}

/**
 * ML-Positionen laden (ml_positions).
 * Fehlte bisher komplett: die Tabelle wurde nur beim Speichern und beim
 * Recall einzeln abgefragt, aber nie geladen und nie an Clients geschickt.
 * Dadurch kannte das Frontend weder Namen noch Belegung der Slots.
 */
async function loadPositions() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT * FROM ml_positions WHERE active = 1 ORDER BY button_index'
    );

    mlPositions.clear();
    for (const row of rows) {
      mlPositions.set(row.button_index, row);
    }

    console.log(`[INIT] Loaded ${mlPositions.size} ML positions.`);
  } finally {
    conn.release();
  }
}

/**
 * Positionsliste für Clients: immer alle Slots, auch leere.
 */
function buildPositionList() {
  const list = [];
  for (let slot = 1; slot <= POSITION_SLOT_COUNT; slot++) {
    const pos = mlPositions.get(slot);
    list.push({
      slot,
      name: pos ? (pos.name ?? null) : null,
      fade_time_sec: pos ? Number(pos.fade_time_sec) : null,
      occupied: !!pos
    });
  }
  return list;
}

/**
 * Pad-Sensitivität aus DB laden.
 * Erwartet Tabelle: ml_settings(name PRIMARY KEY, value VARCHAR)
 */
async function loadPadSettings() {
  const conn = await pool.getConnection();
  try {
    const [rows] = await conn.query(
      'SELECT value FROM ml_settings WHERE name = ? LIMIT 1',
      ['pad_sensitivity']
    );
    if (rows.length) {
      const val = parseFloat(rows[0].value);
      if (!Number.isNaN(val)) {
        padSensitivity = clamp(val, 0.1, 1.0);
      }
    }
    console.log(`[INIT] Pad-Sensitivität: ${padSensitivity}`);
  } catch (err) {
    console.warn('[INIT] Konnte Pad-Sensitivität nicht laden (ml_settings fehlt evtl.):', err.message);
    padSensitivity = DEFAULT_PAD_SENSITIVITY;
  } finally {
    conn.release();
  }
}

/**
 * Pad-Sensitivität in DB speichern.
 */
async function savePadSensitivity(value) {
  const v = clamp(value, 0.1, 1.0);
  const conn = await pool.getConnection();
  try {
    await conn.query(
      'INSERT INTO ml_settings (name, value) VALUES (?, ?) ' +
      'ON DUPLICATE KEY UPDATE value = VALUES(value)',
      ['pad_sensitivity', v.toString()]
    );
    console.log('[SETTINGS] Pad-Sensitivität gespeichert:', v);
  } catch (err) {
    console.error('[SETTINGS] Fehler beim Speichern der Pad-Sensitivität:', err);
  } finally {
    conn.release();
  }
}

/* --------------------------------------------------------
 * Szenen-HTP-Mischung
 * ------------------------------------------------------*/

/**
 * Grandmaster und Blackout auf einen Kanalwert anwenden.
 * Wirkt ausschliesslich auf Kanäle mit is_intensity (PROTOKOLL.md §6).
 */
function applyMaster(valueNorm, ch) {
  if (!ch || !ch.is_intensity) return valueNorm;
  if (blackout) return 0;
  return valueNorm * grandmaster;
}

function mixSceneChannelsHTP() {
  // Für jeden Kanal: max(Beiträge aller Presets, Programmer)
  for (const ch of dmxChannels) {
    let maxVal = 0;

    // Beiträge aller Presets
    for (const [presetId, presetObj] of presets) {
      const level = presetFaderLevels.get(presetId) ?? 0;
      if (level <= 0) continue;

      const maxValue = presetObj.values.get(ch.id) ?? 0;
      const contribution = level * maxValue;
      if (contribution > maxVal) maxVal = contribution;
    }

    // Programmer (zweiter Tab) – HTP
    const progVal = programmerValues.get(ch.id) ?? 0;
    if (progVal > maxVal) maxVal = progVal;

    // Grandmaster/Blackout ganz am Ende der Mischkette, und nur auf
    // Intensitäten (PROTOKOLL.md §6). Pan/Tilt/Zoom/Control bleiben
    // unangetastet – sonst würde ein Blackout den Kopf verstellen.
    outputChannels.set(ch.id, clamp(applyMaster(maxVal, ch), 0, 1));
  }
}

/* --------------------------------------------------------
 * Movinglight-Update (Fades, LTP)
 * ------------------------------------------------------*/

function updateMlState(dt) {
  const beforePan = mlState.pan, beforeTilt = mlState.tilt;
  const beforeZoom = mlState.zoom, beforeDimmer = mlState.dimmer;
  const beforeFading = mlPositionFade !== null;

  // 1) Positions-Fade (z.B. gespeicherte Positionen)
  if (mlPositionFade) {
    mlPositionFade.t += dt;
    const t = clamp(mlPositionFade.t / mlPositionFade.duration, 0, 1);

    const { from, target } = mlPositionFade;

    mlState.pan  = from.pan  + (target.pan  - from.pan)  * t;
    mlState.tilt = from.tilt + (target.tilt - from.tilt) * t;
    mlState.zoom = from.zoom + (target.zoom - from.zoom) * t;
    // Dimmer bleibt unberührt

    if (t >= 1) {
      mlPositionFade = null;
    }
  }

  // 2) Totmann: veraltete Geschwindigkeiten verwerfen, damit der Kopf
  //    nicht weiterfaehrt, wenn der Client verstummt (PROTOKOLL.md §3.2).
  if ((mlPanSpeed !== 0 || mlTiltSpeed !== 0) &&
      Date.now() - mlMoveLastTs > ML_MOVE_TIMEOUT_MS) {
    mlPanSpeed = 0;
    mlTiltSpeed = 0;
    console.warn('[ML] Keine Bewegungsdaten mehr - Geschwindigkeit auf 0 gesetzt.');
  }

  // 3) Joystick-Steuerung (relativ), wenn kein aktiver Fade
  if (!mlPositionFade) {
    // Pan
    if (Math.abs(mlPanSpeed) > JOYSTICK_DEADZONE) {
      const deltaPan = (mlPanSpeed * dt) / JOYSTICK_FULL_RANGE_SEC;
      mlState.pan = clamp(mlState.pan + deltaPan, 0, 1);
    }

    // Tilt
    if (Math.abs(mlTiltSpeed) > JOYSTICK_DEADZONE) {
      const deltaTilt = (mlTiltSpeed * dt) / JOYSTICK_FULL_RANGE_SEC;
      mlState.tilt = clamp(mlState.tilt + deltaTilt, 0, 1);
    }
  }

  // 4) Dimmer weich zum Zielwert fahren.
  //    Muss unabhängig vom Positions-Fade laufen: früher stand das im
  //    if (mlPositionFade)-Block und lief damit nie, weil mlPositionFade
  //    nirgends gesetzt wird. mlState.dimmer blieb dauerhaft 0.
  const dimmerFactor = Math.min(1, dt / DIMMER_SMOOTHING_SEC);
  mlState.dimmer += (mlDimmerTarget - mlState.dimmer) * dimmerFactor;

  // Asymptote abschneiden: sonst ändert sich der Wert in jedem Tick um einen
  // unsichtbar kleinen Betrag und gilt dauerhaft als Änderung - der
  // Zustands-Broadcast würde im Leerlauf nie zur Ruhe kommen.
  if (Math.abs(mlDimmerTarget - mlState.dimmer) < DIMMER_EPSILON) {
    mlState.dimmer = mlDimmerTarget;
  }

  // Zoom kommt direkt aus mlState.zoom (LTP aus ml_live)

  // 4) Bewegt sich etwas, muss der nächste Takt den Zustand verteilen.
  //    Ohne das bliebe eine laufende Positionsfahrt für die Clients unsichtbar.
  if (mlState.pan !== beforePan || mlState.tilt !== beforeTilt ||
      mlState.zoom !== beforeZoom || mlState.dimmer !== beforeDimmer ||
      (mlPositionFade !== null) !== beforeFading) {
    markStateDirty(stateOrigin);
  }
}


/* --------------------------------------------------------
 * DMX / Art-Net
 * ------------------------------------------------------*/

/**
 * Naechste Sequence-Nummer fuer ein Universe (1..255, 0 uebersprungen).
 */
function nextSequence(universe) {
  let seq = (artnetSequence.get(universe) ?? 0) + 1;
  if (seq > 255) seq = 1;
  artnetSequence.set(universe, seq);
  return seq;
}

/**
 * Erste nicht-lokale IPv4-Schnittstelle. Wird fuer die ArtPollReply
 * gebraucht, die die eigene Adresse und MAC nennen muss.
 */
function getPrimaryInterface() {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) return a;
    }
  }
  return null;
}

/**
 * Alle Universes, die dieser Server bespielt.
 */
function getOutputUniverses() {
  const set = new Set();
  for (const ch of dmxChannels) {
    set.add(ch.universe ?? ARTNET_UNIVERSE_DEFAULT);
  }
  if (set.size === 0) set.add(ARTNET_UNIVERSE_DEFAULT);
  return [...set].sort((a, b) => a - b);
}

/**
 * ArtSync-Paket (14 Byte). Weist Nodes an, alle zuvor empfangenen
 * Universes gleichzeitig auszugeben.
 */
function buildArtSyncPacket() {
  const buf = Buffer.alloc(14);
  buf.write('Art-Net', 0, 'ascii');
  buf[7] = 0x00;
  buf[8] = OP_SYNC & 0xFF;
  buf[9] = (OP_SYNC >> 8) & 0xFF;
  buf[10] = 0x00;
  buf[11] = 0x0e;
  return buf;
}

/**
 * ArtPollReply (239 Byte). Damit taucht der Server in Tools wie
 * Artnetominator oder in einer Konsole als Knoten auf - vorher war er
 * fuer eine Suche unsichtbar, weil er auf ArtPoll gar nicht antwortete.
 */
function buildArtPollReplyPacket(universe) {
  const buf = Buffer.alloc(239);
  const iface = getPrimaryInterface();

  buf.write('Art-Net', 0, 'ascii');
  buf[7] = 0x00;
  buf[8] = OP_POLL_REPLY & 0xFF;
  buf[9] = (OP_POLL_REPLY >> 8) & 0xFF;

  // Eigene IP
  const ipParts = (iface ? iface.address : '0.0.0.0').split('.').map(Number);
  buf[10] = ipParts[0] || 0; buf[11] = ipParts[1] || 0;
  buf[12] = ipParts[2] || 0; buf[13] = ipParts[3] || 0;

  // Port (little endian)
  buf.writeUInt16LE(ARTNET_PORT, 14);

  buf[16] = 0x00; buf[17] = 0x01;              // Firmware-Version
  buf[18] = (universe >> 8) & 0x7F;            // NetSwitch
  buf[19] = (universe >> 4) & 0x0F;            // SubSwitch
  buf[20] = 0x00; buf[21] = 0xFF;              // Oem: unbekannt
  buf[22] = 0x00;                              // UBEA
  buf[23] = 0x00;                              // Status1
  buf[24] = 0x00; buf[25] = 0x00;              // ESTA

  buf.write(ARTNET_SHORT_NAME, 26, 17, 'ascii');
  buf.write(ARTNET_LONG_NAME, 44, 63, 'ascii');
  buf.write(`Universe ${universe} OK`, 108, 63, 'ascii');

  buf[172] = 0x00; buf[173] = 0x01;            // ein Port je Reply
  buf[174] = 0x80;                             // PortType: DMX512-Ausgang
  buf[182] = 0x80;                             // GoodOutput: Daten werden gesendet
  buf[190] = universe & 0x0F;                  // SwOut
  buf[200] = 0x01;                             // Style: Controller

  if (iface && iface.mac) {
    const mac = iface.mac.split(':').map(h => parseInt(h, 16));
    for (let i = 0; i < 6; i++) buf[201 + i] = mac[i] || 0;
  }

  buf[207] = ipParts[0] || 0; buf[208] = ipParts[1] || 0;
  buf[209] = ipParts[2] || 0; buf[210] = ipParts[3] || 0;
  buf[211] = 0x01;                             // BindIndex
  buf[212] = 0x08;                             // Status2: Art-Net 3 faehig

  return buf;
}

/**
 * Eingehende Art-Net-Pakete. Interessiert uns nur ArtPoll.
 */
function handleArtnetMessage(msg, rinfo) {
  if (msg.length < 12) return;
  if (msg.toString('ascii', 0, 7) !== 'Art-Net') return;

  const opcode = msg.readUInt16LE(8);
  if (opcode !== OP_POLL) return;

  const socket = artnetSocket;
  if (!socket) return;

  // Je bespieltem Universe eine Antwort, so sieht es die Spec vor.
  for (const uni of getOutputUniverses()) {
    const reply = buildArtPollReplyPacket(uni);
    socket.send(reply, 0, reply.length, ARTNET_PORT, rinfo.address, (err) => {
      if (err && DEBUG_ERRORS) console.error('[ARTNET] ArtPollReply fehlgeschlagen:', err);
    });
  }
  console.log(`[ARTNET] ArtPoll von ${rinfo.address} beantwortet.`);
}

/**
 * ArtDMX-Paket nach Art-Net-Spezifikation bauen.
 * universe: 0..32767
 * dmx: Uint8Array mit bis zu 512 Bytes
 */
function buildArtDmxPacket(universe, dmx) {
  const length = dmx.length;
  const buf = Buffer.alloc(18 + length);

  // ID "Art-Net\0"
  buf.write('Art-Net', 0, 'ascii');
  buf[7] = 0x00;

  // OpCode ArtDMX (0x5000, little endian)
  buf[8] = 0x00;
  buf[9] = 0x50;

  // Protokollversion (hoch/niedrig)
  buf[10] = 0x00;
  buf[11] = 0x0e; // 14

  // Sequence: erlaubt dem Empfaenger, vertauschte Pakete zu erkennen.
  // Stand frueher konstant auf 0 (= Sequencing deaktiviert).
  buf[12] = nextSequence(universe);
  buf[13] = 0x00; // Physical (nur informativ)

  // Universe (little endian, 0..32767)
  buf[14] = universe & 0xFF;
  buf[15] = (universe >> 8) & 0xFF;

  // Length Hi/Lo
  buf[16] = (length >> 8) & 0xFF;
  buf[17] = length & 0xFF;

  // DMX-Daten
  if (Buffer.isBuffer(dmx)) {
    dmx.copy(buf, 18);
  } else {
    buf.set(dmx, 18);
  }

  return buf;
}

/**
 * UDP-Socket lazy initialisieren
 */
function createArtnetSocket(bindPort) {
  const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  let bound = false;

  socket.on('error', (err) => {
    // Der Port wird gebraucht, um ArtPoll zu empfangen. Ist er belegt
    // (z.B. laeuft auf demselben Rechner schon eine Konsole), weichen wir
    // auf einen freien Port aus - senden geht dann weiterhin, nur die
    // Erkennung per ArtPoll faellt weg.
    if (!bound && err.code === 'EADDRINUSE' && bindPort !== 0) {
      console.warn(
        `[ARTNET] Port ${bindPort} ist belegt. Weiche auf einen freien Port aus; ` +
        'ArtPoll-Antworten sind damit nicht moeglich.'
      );
      try { socket.close(); } catch (e) { /* egal */ }
      artnetSocket = createArtnetSocket(0);
      return;
    }
    console.error('[ARTNET] Socket-Fehler:', err);
    // Socket offen lassen; Art-Net-Ausgabe kann temporär gestört sein.
  });

  socket.on('message', (msg, rinfo) => {
    try {
      handleArtnetMessage(msg, rinfo);
    } catch (err) {
      if (DEBUG_ERRORS) console.error('[ARTNET] Fehler beim Empfang:', err);
    }
  });

  // setBroadcast() ist erst nach dem Binden erlaubt. Sends, die vorher
  // abgesetzt werden, puffert Node selbst und schickt sie danach raus.
  socket.bind(bindPort, () => {
    bound = true;
    if (ARTNET_BROADCAST) {
      try {
        socket.setBroadcast(true);
      } catch (err) {
        console.error('[ARTNET] Broadcast konnte nicht aktiviert werden:', err);
      }
    }
    const addr = socket.address();
    console.log(
      `[ARTNET] Socket auf ${addr.address}:${addr.port} - ` +
      (addr.port === ARTNET_PORT
        ? 'ArtPoll wird beantwortet.'
        : (ARTNET_DISCOVERY ? 'keine ArtPoll-Antworten (Port belegt).' : 'ArtPoll-Antworten abgeschaltet.'))
    );
  });

  return socket;
}

function getArtnetSocket() {
  if (!artnetSocket) {
    artnetSocket = createArtnetSocket(ARTNET_DISCOVERY ? ARTNET_PORT : 0);
    console.log(
      '[ARTNET] Ausgabe im ' + (ARTNET_BROADCAST ? 'Broadcast' : 'Unicast') +
      '-Modus an ' + ARTNET_TARGET + ':' + ARTNET_PORT +
      (ARTNET_SYNC ? ', ArtSync aktiv' : '')
    );
  }
  return artnetSocket;
}

function buildDmxUniverses() {
  // universe -> Uint8Array(512)
  const universes = new Map();

  function getUniverseArray(universe) {
    if (!universes.has(universe)) {
      universes.set(universe, new Uint8Array(DMX_UNIVERSE_SIZE));
    }
    return universes.get(universe);
  }

  // 1) Szenen-Kanäle (outputChannels) auf DMX schreiben
  for (const ch of dmxChannels) {
    const uni = ch.universe ?? ARTNET_UNIVERSE_DEFAULT;
    const arr = getUniverseArray(uni);

    const valueNorm = outputChannels.get(ch.id) ?? 0;
    const valueByte = Math.round(clamp(valueNorm, 0, 1) * 255);

    if (ch.dmx_address >= 1 && ch.dmx_address <= DMX_UNIVERSE_SIZE) {
      arr[ch.dmx_address - 1] = valueByte;
    }
  }

  // 2) Movinglights: Pan/Tilt/Zoom/Dimmer explizit setzen
  for (const ml of mlFixtures) {
    const panChannel = channelById.get(ml.pan_channel_id);
    if (!panChannel) continue;

    const uni = panChannel.universe ?? ARTNET_UNIVERSE_DEFAULT;
    const arr = getUniverseArray(uni);

    const tiltChannel = channelById.get(ml.tilt_channel_id);
    const panFineChannel = ml.pan_fine_channel_id ? channelById.get(ml.pan_fine_channel_id) : null;
    const tiltFineChannel = ml.tilt_fine_channel_id ? channelById.get(ml.tilt_fine_channel_id) : null;
    const zoomChannel = ml.zoom_channel_id ? channelById.get(ml.zoom_channel_id) : null;
    const dimmerChannel = ml.dimmer_channel_id ? channelById.get(ml.dimmer_channel_id) : null;

    function set16bit(chCoarse, chFine, norm) {
      if (!chCoarse) return;
      const v16 = Math.round(clamp(norm, 0, 1) * 65535);
      const coarse = (v16 >> 8) & 0xFF;
      const fine = v16 & 0xFF;

      if (chCoarse.dmx_address >= 1 && chCoarse.dmx_address <= DMX_UNIVERSE_SIZE) {
        arr[chCoarse.dmx_address - 1] = coarse;
      }
      if (chFine && chFine.dmx_address >= 1 && chFine.dmx_address <= DMX_UNIVERSE_SIZE) {
        arr[chFine.dmx_address - 1] = fine;
      }
    }

    function set8bit(ch, norm, htpWithScene = false) {
      if (!ch) return;
      let vNorm = clamp(norm, 0, 1);
      if (htpWithScene) {
        const sceneVal = outputChannels.get(ch.id) ?? 0;
        vNorm = Math.max(vNorm, sceneVal);
      }
      const v = Math.round(vNorm * 255);
      if (ch.dmx_address >= 1 && ch.dmx_address <= DMX_UNIVERSE_SIZE) {
        arr[ch.dmx_address - 1] = v;
      }
    }

    // Laufrichtung kommt aus ml_fixtures, nicht mehr fest aus dem Code.
    // pan_invert = 1 entspricht dem frueheren hart verdrahteten (1 - pan).
    const panNorm  = ml.pan_invert  ? 1 - mlState.pan  : mlState.pan;
    const tiltNorm = ml.tilt_invert ? 1 - mlState.tilt : mlState.tilt;

    set16bit(panChannel,  panFineChannel,  panNorm);
    set16bit(tiltChannel, tiltFineChannel, tiltNorm);

    if (zoomChannel) {
      set8bit(zoomChannel, mlState.zoom, false);
    }

    if (dimmerChannel) {
      // Der ML-Dimmer ist eine Intensität und gehoert damit unter den
      // Master. Der Szenenanteil in set8bit kommt aus outputChannels und
      // wurde dort bereits gemastert.
      set8bit(dimmerChannel, applyMaster(mlState.dimmer, dimmerChannel), true);
    }
  }
  
  // 3) Konstant zu haltende Fixture-Kanäle (Shutter, Fixture-Mode, ...)
  // Kommt aus dmx_channels.fixed_value und überschreibt alles davor.
  // Früher war hier eine feste ID-Liste [33..39] verdrahtet.
  for (const ch of dmxChannels) {
    if (ch.fixed_value == null) continue;

    const uni = ch.universe ?? ARTNET_UNIVERSE_DEFAULT;
    const arr = getUniverseArray(uni);

    if (ch.dmx_address >= 1 && ch.dmx_address <= DMX_UNIVERSE_SIZE) {
      arr[ch.dmx_address - 1] = clamp(Math.round(ch.fixed_value), 0, 255);
    }
  }

  return universes;
}

function sendDmx(universes) {
  if (!universes || universes.size === 0) return;

  const socket = getArtnetSocket();

  for (const [uni, dmxArray] of universes) {
    const packet = buildArtDmxPacket(uni, dmxArray);

    socket.send(packet, 0, packet.length, ARTNET_PORT, ARTNET_TARGET, (err) => {
      if (err && DEBUG_ERRORS) {
        console.error('[ARTNET] Send-Fehler (Universe', uni, '):', err);
      }
    });
  }

  // ArtSync erst nach allen ArtDMX-Paketen: Nodes im Sync-Modus geben
  // damit alle Universes im selben Moment aus statt nacheinander.
  if (ARTNET_SYNC) {
    const sync = buildArtSyncPacket();
    socket.send(sync, 0, sync.length, ARTNET_PORT, ARTNET_TARGET, (err) => {
      if (err && DEBUG_ERRORS) console.error('[ARTNET] ArtSync-Fehler:', err);
    });
  }
}


/* --------------------------------------------------------
 * WebSocket-Server
 * ------------------------------------------------------*/

function setupWebSocketServer() {
  wss = new WebSocket.Server({ port: WS_PORT });
  console.log(`[WS] Server läuft auf ws://0.0.0.0:${WS_PORT}`);
  console.log(`[WS] Heartbeat alle ${WS_PING_INTERVAL_MS} ms.`);

  // Server-weite Fehler
  wss.on('error', (err) => {
    console.error('[WS] Server-Fehler:', err);
  });

  // Tote Verbindungen einsammeln. Ein abgezogenes Tablet meldet sich nicht
  // ab - ohne diesen Takt bliebe seine Verbindung dauerhaft in wss.clients.
  const pingTimer = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        console.log(`[WS] Keine Antwort von ${ws.clientId}, Verbindung wird beendet.`);
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        if (DEBUG_ERRORS) console.error('[WS] ping fehlgeschlagen:', err);
      }
    }
  }, WS_PING_INTERVAL_MS);

  wss.on('close', () => clearInterval(pingTimer));

  wss.on('connection', (ws) => {
    // Kurze Kennung je Verbindung. Wird als `origin` im state-Broadcast
    // mitgeschickt; mit v2 bekommt der Client sie über `hello` (PROTOKOLL.md §2).
    ws.clientId = crypto.randomUUID().slice(0, 6);

    // Heartbeat: Der Client antwortet auf ping automatisch mit pong.
    // Bleibt das aus, gilt die Verbindung beim naechsten Durchlauf als tot.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    console.log(`[WS] Client verbunden (${ws.clientId})`);

    // Fehler je Client-Socket
    ws.on('error', (err) => {
      console.error('[WS] Client-Socket-Fehler:', err);
    });

    ws.on('message', async (data) => {
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch (e) {
        console.warn('[WS] Ungültiges JSON:', e);
        return;
      }

      try {
        await handleClientMessage(ws, msg);
        if (STATE_MUTATING_TYPES.has(msg.type)) {
          markStateDirty(ws.clientId);
        }
      } catch (err) {
        console.error('[WS] Fehler beim Verarbeiten der Nachricht:', err);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client getrennt');
    });

    // Initialzustand aus dem Cache schicken - ohne DB-Zugriff.
    // Frueher wurden hier bei JEDEM Connect Presets und Settings neu
    // geladen; ein Reconnect-Storm erzeugte damit DB-Last. Aenderungen
    // an der Konfiguration kommen jetzt ueber reloadAll() herein
    // (SIGHUP oder system.reload, B3.3).
    sendHandshake(ws);
  });
}

function broadcast(obj) {
  const data = JSON.stringify(obj);
  if (!wss) return;
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  });
}

/**
 * Patch, Presets, Positionen und Settings neu aus der DB laden,
 * ohne den Prozess neu zu starten (B3.3).
 * Ausgeloest per SIGHUP oder per `system.reload` ueber WebSocket.
 * Laufende Faderstaende und der ML-Zustand bleiben erhalten.
 */
let reloadInFlight = false;

async function reloadAll(reason) {
  if (reloadInFlight) {
    console.warn('[RELOAD] Läuft bereits, Anfrage ignoriert.');
    return false;
  }
  reloadInFlight = true;
  try {
    console.log(`[RELOAD] Lade Konfiguration neu (${reason}) ...`);
    await loadPatch();
    await loadPresets();
    await loadPositions();
    await loadPadSettings();
    markStateDirty(null);
    console.log('[RELOAD] Fertig.');
    return true;
  } catch (err) {
    console.error('[RELOAD] Fehlgeschlagen, alter Stand bleibt aktiv:', err);
    return false;
  } finally {
    reloadInFlight = false;
  }
}

/**
 * Joystick-Geschwindigkeit setzen (ml.move).
 * Bricht eine laufende Positionsfahrt nur bei echter Auslenkung ab: ein
 * ruhender Client sendet dauerhaft 0 und darf den Fade nicht killen.
 */
function applyMlMove(panSpeed, tiltSpeed) {
  const p = typeof panSpeed  === 'number' ? clamp(panSpeed,  -1, 1) : 0;
  const t = typeof tiltSpeed === 'number' ? clamp(tiltSpeed, -1, 1) : 0;

  if (mlPositionFade &&
      (Math.abs(p) > JOYSTICK_DEADZONE || Math.abs(t) > JOYSTICK_DEADZONE)) {
    mlPositionFade = null;
  }

  mlPanSpeed = p;
  mlTiltSpeed = t;
  mlMoveLastTs = Date.now();
}

/**
 * Positionsfahrt starten. Bei fade <= 0 wird sofort gesetzt.
 * Der Interpolationscode in updateMlState() war immer vorhanden, wurde
 * aber nie ausgelöst, weil beide Recall-Handler hart gesetzt haben.
 */
function startPositionFade(targetPan, targetTilt, targetZoom, fadeSec) {
  if (!(fadeSec > 0)) {
    mlPositionFade = null;
    mlState.pan  = targetPan;
    mlState.tilt = targetTilt;
    mlState.zoom = targetZoom;
    return;
  }

  mlPositionFade = {
    from:   { pan: mlState.pan, tilt: mlState.tilt, zoom: mlState.zoom },
    target: { pan: targetPan,   tilt: targetTilt,   zoom: targetZoom },
    duration: fadeSec,
    t: 0
  };
  // Dimmer bleibt bewusst unberührt (Show-Situation).
}

/**
 * Änderung vormerken. Der nächste Takt schickt den Zustand an alle.
 * `origin` ist die client_id des Auslösers, damit ein Client seinen
 * eigenen Anstoß erkennen kann (PROTOKOLL.md §4.3, §5).
 */
// Nachrichtentypen, die den Serverzustand verändern können.
const STATE_MUTATING_TYPES = new Set([
  // v2
  'ml.move', 'ml.goto', 'ml.zoom', 'ml.dimmer',
  'preset.fader', 'preset.save', 'preset.delete',
  'programmer.channel', 'programmer.clear',
  'position.store', 'position.recall', 'position.delete', 'position.update',
  'settings.pad_sensitivity',
  'master.grandmaster', 'master.blackout', 'system.reload',
  // v1, bis das neue Frontend steht
  'ml_live', 'ml_sensitivity', 'preset_fader', 'programmer_channel',
  'save_preset', 'ml_pos_store', 'ml_pos_recall'
]);

function markStateDirty(origin = null) {
  stateDirty = true;
  stateOrigin = origin;
}

/**
 * Vollständiger Zustands-Snapshot (PROTOKOLL.md §4.3).
 * preset_levels und programmer enthalten nur Einträge ungleich 0.
 */
function buildStateMessage(origin) {
  const presetLevels = {};
  for (const [id, lvl] of presetFaderLevels) {
    if (lvl > 0) presetLevels[id] = lvl;
  }

  const programmer = {};
  for (const [id, val] of programmerValues) {
    if (val > 0) programmer[id] = val;
  }

  return {
    type: 'state',
    seq: ++stateSeq,
    origin: origin ?? null,
    ml: {
      pan: mlState.pan,
      tilt: mlState.tilt,
      zoom: mlState.zoom,
      dimmer: mlState.dimmer,
      fading: mlPositionFade !== null
    },
    master: { grandmaster, blackout },
    preset_levels: presetLevels,
    programmer,
    pad_sensitivity: padSensitivity
  };
}

/**
 * Sendetakt: nur bei Änderung, mindestens aber alle STATE_KEEPALIVE_MS.
 * Damit bleibt der Broadcast im Leerlauf still, ohne dass ein Client
 * veraltete Werte behält.
 */
function stateTick() {
  const now = Date.now();
  if (!stateDirty && (now - lastStateSentTs) < STATE_KEEPALIVE_MS) return;

  broadcast(buildStateMessage(stateOrigin));
  stateDirty = false;
  stateOrigin = null;
  lastStateSentTs = now;
}

/* --------------------------------------------------------
 * WebSocket: Nachrichten behandeln
 * ------------------------------------------------------*/

async function handleClientMessage(ws, msg) {
  if (DEBUG_WS_IN) {
    console.log('[WS-IN]', msg);
  }
  switch (msg.type) {
    // --- Movinglight (PROTOKOLL.md §3.2) -------------------------------
    // Der Client schickt Absichten, keine Zustaende. Nur ml.move ist
    // fortlaufend und faellt deshalb unter den Totmann-Schalter.
    case 'ml.move':
      applyMlMove(msg.pan_speed, msg.tilt_speed);
      break;

    case 'ml.goto':
      mlPositionFade = null;
      if (typeof msg.pan  === 'number') mlState.pan  = clamp(msg.pan, 0, 1);
      if (typeof msg.tilt === 'number') mlState.tilt = clamp(msg.tilt, 0, 1);
      break;

    case 'ml.zoom':
      if (typeof msg.value === 'number') mlState.zoom = clamp(msg.value, 0, 1);
      break;

    case 'ml.dimmer':
      if (typeof msg.value === 'number') mlDimmerTarget = clamp(msg.value, 0, 1);
      break;

    // v1-Sammelnachricht. Bleibt, bis das neue Frontend steht, und wird
    // auf die v2-Befehle abgebildet (PROTOKOLL.md §9).
    case 'ml_live':
      if (msg.mode === 'velocity') {
        applyMlMove(msg.pan_speed, msg.tilt_speed);
      } else if (typeof msg.pan === 'number' || typeof msg.tilt === 'number') {
        mlPositionFade = null;
        if (typeof msg.pan  === 'number') mlState.pan  = clamp(msg.pan, 0, 1);
        if (typeof msg.tilt === 'number') mlState.tilt = clamp(msg.tilt, 0, 1);
      }
      if (typeof msg.zoom   === 'number') mlState.zoom  = clamp(msg.zoom, 0, 1);
      if (typeof msg.dimmer === 'number') mlDimmerTarget = clamp(msg.dimmer, 0, 1);
      break;

    // Konfiguration neu einlesen (PROTOKOLL.md §3.7).
    case 'system.reload': {
      const ok = await reloadAll(`WS ${ws.clientId}`);
      if (ok) {
        broadcast({ type: 'reloaded' });
        // Der Reload kann auch den Patch veraendert haben, nicht nur die
        // Bibliothek — deshalb beides neu verteilen.
        broadcast(buildPatchMessage());
        broadcastLibrary();
      } else {
        ws.send(JSON.stringify({
          type: 'error', code: 'reload_failed', ref: 'system.reload',
          message: 'Neu laden fehlgeschlagen, alter Stand bleibt aktiv.'
        }));
      }
      break;
    }

    // Master-Sektion. Neu in v2, ohne v1-Vorgaenger (PROTOKOLL.md §3.1).
    case 'master.grandmaster':
      if (typeof msg.value === 'number') {
        grandmaster = clamp(msg.value, 0, 1);
        console.log('[MASTER] Grandmaster:', grandmaster.toFixed(3));
      }
      break;

    case 'master.blackout':
      if (typeof msg.on === 'boolean') {
        blackout = msg.on;
        console.log('[MASTER] Blackout:', blackout ? 'AN' : 'aus');
      }
      break;

    case 'settings.pad_sensitivity':
    case 'ml_sensitivity':                     // v1-Name
      // { type: 'ml_sensitivity', value }
      if (typeof msg.value === 'number') {
        const val = clamp(msg.value, 0.1, 1.0);
        padSensitivity = val;
        await savePadSensitivity(val);
        // optional: an alle Clients broadcasten
        broadcast({ type: 'pad_sensitivity', value: val });
      }
      break;

    // --- Presets (PROTOKOLL.md §3.3) -------------------------------------
    case 'preset.fader':
    case 'preset_fader': {                     // v1-Name
      if (msg.preset_id == null) return;
      // v2 nennt das Feld `level`, v1 `value`.
      const lvl = typeof msg.level === 'number' ? msg.level : msg.value;
      presetFaderLevels.set(msg.preset_id, clamp(lvl ?? 0, 0, 1));
      break;
    }

    case 'preset.save':
    case 'save_preset':                        // v1-Name
      await handleSavePreset(ws, msg);
      break;

    case 'preset.delete':
      await handlePresetDelete(ws, msg);
      break;

    // --- Programmer (PROTOKOLL.md §3.4) ----------------------------------
    case 'programmer.channel':
    case 'programmer_channel':                 // v1-Name
      if (msg.channel_id == null) return;
      programmerValues.set(msg.channel_id, clamp(msg.value ?? 0, 0, 1));
      break;

    case 'programmer.clear':
      // Ohne diesen Weg blieb ein einmal gesetzter Wert bis zum Neustart
      // stehen - es gab schlicht keine Moeglichkeit, auf 0 zurueckzukommen.
      programmerValues.clear();
      console.log('[PROGRAMMER] Alle Werte geleert.');
      break;

    // Neue Message-Typen für Positions-Buttons
    // --- ML-Positionen (PROTOKOLL.md §3.5) ------------------------------
    case 'position.store':
    case 'ml_pos_store':                       // v1-Name
      await handleMlPosStore(ws, msg);
      break;

    case 'position.recall':
    case 'ml_pos_recall':                      // v1-Name
      await handleMlPosRecall(ws, msg);
      break;

    case 'position.delete':
      await handlePositionDelete(ws, msg);
      break;

    case 'position.update':
      await handlePositionUpdate(ws, msg);
      break;

    default:
      console.warn('[WS] Unbekannter Nachrichtentyp:', msg.type);
  }
}

/**
 * Preset loeschen (PROTOKOLL.md §3.3). Die Werte haengen per ON DELETE
 * CASCADE dran, der Faderstand wird mit entfernt.
 */
async function handlePresetDelete(ws, msg) {
  const presetId = msg.preset_id;
  if (presetId == null) {
    ws.send(JSON.stringify({ type: 'error', code: 'bad_request',
      ref: 'preset.delete', message: 'preset_id fehlt.' }));
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [res] = await conn.query('DELETE FROM light_presets WHERE id = ?', [presetId]);
    if (!res.affectedRows) {
      ws.send(JSON.stringify({ type: 'error', code: 'not_found',
        ref: 'preset.delete', message: `Preset ${presetId} existiert nicht.` }));
      return;
    }
    presetFaderLevels.delete(presetId);
    presets.delete(presetId);
    console.log(`[PRESET] ${presetId} geloescht.`);
    broadcastLibrary();
  } catch (err) {
    console.error('[PRESET] Fehler beim Loeschen:', err);
    ws.send(JSON.stringify({ type: 'error', code: 'delete_failed',
      ref: 'preset.delete', message: 'Preset konnte nicht geloescht werden.' }));
  } finally {
    conn.release();
  }
}

/**
 * ML-Position loeschen (PROTOKOLL.md §3.5).
 */
async function handlePositionDelete(ws, msg) {
  const slot = msg.slot;
  if (slot == null) {
    ws.send(JSON.stringify({ type: 'error', code: 'bad_request',
      ref: 'position.delete', message: 'slot fehlt.' }));
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [res] = await conn.query('DELETE FROM ml_positions WHERE button_index = ?', [slot]);
    if (!res.affectedRows) {
      ws.send(JSON.stringify({ type: 'error', code: 'not_found',
        ref: 'position.delete', message: `Slot ${slot} ist nicht belegt.` }));
      return;
    }
    await loadPositions();
    console.log(`[ML] Position Slot ${slot} geloescht.`);
    broadcastLibrary();
  } catch (err) {
    console.error('[ML] Fehler beim Loeschen der Position:', err);
    ws.send(JSON.stringify({ type: 'error', code: 'delete_failed',
      ref: 'position.delete', message: 'Position konnte nicht geloescht werden.' }));
  } finally {
    conn.release();
  }
}

/**
 * Metadaten eines Positionsslots aendern, ohne die Koordinaten anzufassen
 * (PROTOKOLL.md §3.5, Entscheidung §10.3).
 *
 * `position.store` speichert bewusst immer den aktuellen mlState — damit
 * liesse sich ein Slot aber nicht umbenennen und keine Fadezeit korrigieren,
 * ohne den Kopf vorher dorthin zu fahren und die Position zu ueberschreiben.
 * Genau diese Luecke schliesst `position.update`. Pan/Tilt/Zoom bleiben
 * unberuehrt; Koordinaten kommen weiterhin ausschliesslich aus dem
 * Serverzustand.
 */
async function handlePositionUpdate(ws, msg) {
  const slot = msg.slot;
  if (slot == null) {
    ws.send(JSON.stringify({ type: 'error', code: 'bad_request',
      ref: 'position.update', message: 'slot fehlt.' }));
    return;
  }

  const fields = [];
  const params = [];

  if (typeof msg.name === 'string' && msg.name.trim() !== '') {
    fields.push('name = ?');
    params.push(msg.name.trim());
  }
  if (typeof msg.fade_time_sec === 'number' && msg.fade_time_sec >= 0) {
    fields.push('fade_time_sec = ?');
    params.push(clamp(msg.fade_time_sec, 0, 60));
  }

  if (!fields.length) {
    ws.send(JSON.stringify({ type: 'error', code: 'bad_request',
      ref: 'position.update', message: 'Weder name noch fade_time_sec angegeben.' }));
    return;
  }

  const conn = await pool.getConnection();
  try {
    // Nur belegte Slots: sonst entstuende hier eine Position ohne Koordinaten.
    const [res] = await conn.query(
      `UPDATE ml_positions SET ${fields.join(', ')} WHERE button_index = ? AND active = 1`,
      [...params, slot]
    );
    if (!res.affectedRows) {
      ws.send(JSON.stringify({ type: 'error', code: 'not_found',
        ref: 'position.update',
        message: `Slot ${slot} ist nicht belegt — zuerst position.store.` }));
      return;
    }
    await loadPositions();
    console.log(`[ML] Position Slot ${slot} aktualisiert (${fields.length} Feld(er)).`);
    broadcastLibrary();
  } catch (err) {
    console.error('[ML] Fehler beim Aktualisieren der Position:', err);
    ws.send(JSON.stringify({ type: 'error', code: 'update_failed',
      ref: 'position.update', message: 'Position konnte nicht geaendert werden.' }));
  } finally {
    conn.release();
  }
}

/**
 * Presets und Positionen an alle Clients verteilen (PROTOKOLL.md §4.2).
 * Das alte Frontend kennt `library` noch nicht und bekommt daneben sein
 * init_state — faellt mit dem Frontend-Neubau weg.
 */
function broadcastLibrary() {
  if (!wss) return;
  const lib = JSON.stringify(buildLibraryMessage());
  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    client.send(lib);
    sendInitStateLegacy(client);
  }
  markStateDirty(null);
}

/* --------------------------------------------------------
 * Presets speichern
 * ------------------------------------------------------*/

async function handleSavePreset(ws, msg) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let presetId = msg.preset_id || null;
    let source;
    const name = msg.name || 'Preset';
    const page = msg.page || 1;
    const faderIndex = msg.fader_index || 1;

    if (!presetId) {
      // Belegten Slot nicht stillschweigend ueberschreiben (PROTOKOLL.md §3.3).
      // Frueher legte der Server einfach an und lief in den Unique-Index
      // (page, fader_index) - der Client bekam einen nichtssagenden Fehler.
      const [taken] = await conn.query(
        'SELECT id, name FROM light_presets WHERE page = ? AND fader_index = ?',
        [page, faderIndex]
      );
      if (taken.length) {
        await conn.rollback();
        ws.send(JSON.stringify({
          type: 'error',
          code: 'slot_occupied',
          ref: 'preset.save',
          message: `Seite ${page}, Fader ${faderIndex} ist bereits mit "${taken[0].name}" belegt.`,
          preset_id: taken[0].id
        }));
        return;
      }

      const [res] = await conn.query(
        'INSERT INTO light_presets (name, page, fader_index, active) VALUES (?, ?, ?, 1)',
        [name, page, faderIndex]
      );
      presetId = res.insertId;
    } else {
      await conn.query(
        'UPDATE light_presets SET name = ?, page = ?, fader_index = ? WHERE id = ?',
        [name, page, faderIndex, presetId]
      );
      await conn.query(
        'DELETE FROM light_preset_values WHERE preset_id = ?',
        [presetId]
      );
    }

    // Quelle der Werte (PROTOKOLL.md §3.3, Entscheidung §10.2):
    // `channels` ist der Normalfall — explizit, testbar, erlaubt eine
    // kuratierte Auswahl. Fehlt es, friert der Server ein, was gerade im
    // Programmer steht. Das ist das gewohnte "Store"-Verhalten echter Pulte
    // und erspart dem Client, den Programmer-Inhalt zu spiegeln und
    // zurueckzuschicken (wobei er gegen zwischenzeitliche Aenderungen
    // laufen koennte).
    let values;
    if (Array.isArray(msg.channels)) {
      values = msg.channels
        .filter(ch => ch.channel_id != null && ch.max_value != null)
        .map(ch => [
          presetId,
          ch.channel_id,
          clamp(ch.max_value, 0, 1)
        ]);
      source = 'channels';
    } else {
      // Nur Kanaele ungleich 0 — ein Preset aus lauter Nullen waere leer,
      // aber nicht leer gespeichert.
      values = [];
      for (const [channelId, val] of programmerValues) {
        if (val > 0) values.push([presetId, channelId, clamp(val, 0, 1)]);
      }
      source = 'programmer';
    }

    if (values.length > 0) {
      await conn.query(
        'INSERT INTO light_preset_values (preset_id, channel_id, max_value) VALUES ?',
        [values]
      );
    }

    await conn.commit();

    await loadPresets();

    // Alle Clients bekommen die neue Bibliothek, nicht nur der Absender
    // (PROTOKOLL.md §1, Regel 3). Die Einzelbestaetigung bleibt, bis das
    // neue Frontend steht.
    broadcastLibrary();

    ws.send(JSON.stringify({ type: 'preset_saved', preset_id: presetId }));
    console.log(`[PRESET] Preset ${presetId} gespeichert (${name}), ${values.length} Kanaele aus ${source}.`);
  } catch (err) {
    await conn.rollback();
    console.error('[PRESET] Fehler beim Speichern:', err);
    ws.send(JSON.stringify({ type: 'error', message: 'Preset konnte nicht gespeichert werden.' }));
  } finally {
    conn.release();
  }
}

/* --------------------------------------------------------
 * ML-Positionen – neue Message-Typen (ml_pos_store / ml_pos_recall)
 * ------------------------------------------------------*/

async function handleMlPosStore(ws, msg) {
  const conn = await pool.getConnection();
  try {
    const slot = msg.slot;
    if (slot == null) {
      throw new Error('slot fehlt');
    }

    // WICHTIG:
    // Immer den aktuellen absoluten Zustand des Servers speichern,
    // NIE die Werte aus der Message (das sind bei dir Velocity-Werte).
    const pn = clamp(mlState.pan, 0, 1);
    const tn = clamp(mlState.tilt, 0, 1);
    const zn = clamp(mlState.zoom, 0, 1);

    // Fadezeit aus der Message uebernehmen, sonst Standard.
    // Stand frueher fest auf 1.0, wodurch fade_time_sec nie vom Client
    // gesetzt werden konnte.
    const fade = (typeof msg.fade_time_sec === 'number' && msg.fade_time_sec >= 0)
      ? clamp(msg.fade_time_sec, 0, 60)
      : DEFAULT_POSITION_FADE_SEC;

    const [rows] = await conn.query(
      'SELECT id FROM ml_positions WHERE button_index = ?',
      [slot]
    );

    const name = msg.name || `Pos ${slot}`;

    if (rows.length) {
      await conn.query(
        'UPDATE ml_positions SET name = ?, pan_norm = ?, tilt_norm = ?, zoom_norm = ?, fade_time_sec = ?, active = 1 WHERE button_index = ?',
        [name, pn, tn, zn, fade, slot]
      );
    } else {
      await conn.query(
        'INSERT INTO ml_positions (name, button_index, pan_norm, tilt_norm, zoom_norm, fade_time_sec, active) ' +
        'VALUES (?,?,?,?,?,?,1)',
        [name, slot, pn, tn, zn, fade]
      );
    }

    // Cache auffrischen, damit init_state und kuenftige Clients
    // den neuen Namen und die Belegung sehen.
    await loadPositions();
    broadcastLibrary();

    ws.send(JSON.stringify({ type: 'ml_position_saved', slot }));
    console.log(
      `[ML] Position auf Slot ${slot} gespeichert (${name}) – pan=${pn.toFixed(3)}, tilt=${tn.toFixed(3)}, zoom=${zn.toFixed(3)}`
    );
  } catch (err) {
    console.error('[ML] Fehler beim Speichern der Position (ml_pos_store):', err);
    ws.send(JSON.stringify({ type: 'error', message: 'ML-Position konnte nicht gespeichert werden.' }));
  } finally {
    conn.release();
  }
}

async function handleMlPosRecall(ws, msg) {
  const conn = await pool.getConnection();
  try {
    const slot = msg.slot;
    if (slot == null) {
      throw new Error('slot fehlt');
    }

    const [rows] = await conn.query(
      'SELECT * FROM ml_positions WHERE button_index = ? AND active = 1',
      [slot]
    );
    if (!rows.length) {
      ws.send(JSON.stringify({ type: 'error', message: 'ML-Position nicht gefunden.' }));
      return;
    }

    const pos = rows[0];
    const fade = pos.fade_time_sec || 1.0;

    // Zielwerte clampen
    const targetPan   = clamp(pos.pan_norm,  0, 1);
    const targetTilt  = clamp(pos.tilt_norm, 0, 1);
    const targetZoom  = clamp(pos.zoom_norm, 0, 1);

    startPositionFade(targetPan, targetTilt, targetZoom, fade);

    // Der Client bekommt das Ziel, nicht den Startwert - sonst zeigte seine
    // GUI waehrend der Fahrt noch die alte Position. Den Verlauf liefert
    // ohnehin der state-Broadcast.
    const reply = {
      type: 'ml_position_recalled',
      slot,
      fade_time_sec: fade,
      ml_state: {
        pan:    targetPan,
        tilt:   targetTilt,
        zoom:   targetZoom,
        dimmer: mlState.dimmer
      }
    };
    ws.send(JSON.stringify(reply));

    console.log(
      `[ML] Position Slot ${slot} recall – pan=${targetPan.toFixed(3)}, ` +
      `tilt=${targetTilt.toFixed(3)}, zoom=${targetZoom.toFixed(3)}, fade=${fade}s`
    );
  } catch (err) {
    console.error('[ML] Fehler beim Recall der Position (ml_pos_recall):', err);
    ws.send(JSON.stringify({ type: 'error', message: 'ML-Position konnte nicht geladen werden.' }));
  } finally {
    conn.release();
  }
}



/* --------------------------------------------------------
 * Verbindungssequenz (PROTOKOLL.md §2)
 *
 *   hello  →  patch  →  library  →  state
 *
 * `patch` und `library` sind gross und aendern sich selten, `state` ist
 * der erste vollstaendige Zustands-Snapshot. Der Client sendet zum Aufbau
 * nichts; passt seine Protokollversion nicht, trennt er selbst.
 * ------------------------------------------------------*/

function buildPresetList() {
  const list = [];
  for (const [id, p] of presets) {
    list.push({
      id,
      name: p.meta.name,
      page: p.meta.page,
      fader_index: p.meta.fader_index
    });
  }
  return list;
}

function buildChannelList() {
  return dmxChannels.map(ch => ({
    id: ch.id,
    name: ch.name || `Ch ${ch.id}`,
    universe: ch.universe ?? ARTNET_UNIVERSE_DEFAULT,
    dmx_address: ch.dmx_address,
    channel_group: ch.channel_group ?? null,
    fixed_value: ch.fixed_value ?? null,
    is_intensity: !!ch.is_intensity
  }));
}

/** Patch: Kanaele und Movinglights (PROTOKOLL.md §4.1). */
function buildPatchMessage() {
  return {
    type: 'patch',
    channels: buildChannelList(),
    ml_fixtures: mlFixtures.map(ml => ({
      id: ml.id,
      name: ml.name,
      pan: ml.pan_channel_id,
      pan_fine: ml.pan_fine_channel_id ?? null,
      tilt: ml.tilt_channel_id,
      tilt_fine: ml.tilt_fine_channel_id ?? null,
      zoom: ml.zoom_channel_id ?? null,
      dimmer: ml.dimmer_channel_id ?? null,
      pan_invert: !!ml.pan_invert,
      tilt_invert: !!ml.tilt_invert
    }))
  };
}

/** Bibliothek: Presets und alle Positionsslots (PROTOKOLL.md §4.2). */
function buildLibraryMessage() {
  return {
    type: 'library',
    presets: buildPresetList(),
    positions: buildPositionList()
  };
}

/**
 * Die vier Aufbaunachrichten an einen frisch verbundenen Client.
 * Der `state` geht hier direkt raus statt auf den naechsten Takt zu warten —
 * sonst saehe ein neuer Client bis zu STATE_KEEPALIVE_MS lang nichts.
 */
function sendHandshake(ws) {
  ws.send(JSON.stringify({
    type: 'hello',
    protocol: PROTOCOL_VERSION,
    client_id: ws.clientId,
    server_time: Date.now()
  }));
  ws.send(JSON.stringify(buildPatchMessage()));
  ws.send(JSON.stringify(buildLibraryMessage()));
  ws.send(JSON.stringify(buildStateMessage(null)));

  // Solange das alte Frontend laeuft, braucht es weiterhin sein init_state.
  // Faellt mit dem Frontend-Neubau weg (Schritt 4: v1-Aliase entfernen).
  sendInitStateLegacy(ws);
}

/* --------------------------------------------------------
 * v1: Initialzustand an Client schicken — nur noch fuer das alte Frontend
 * ------------------------------------------------------*/

function sendInitStateLegacy(ws) {
  const presetsArray = buildPresetList().map(p => ({
    ...p,
    level: presetFaderLevels.get(p.id) ?? 0
  }));

  const msg = {
    type: 'init_state',
    presets: presetsArray,
    channels: buildChannelList(),
    positions: buildPositionList(),
    ml_state: {
      pan: mlState.pan,
      tilt: mlState.tilt,
      zoom: mlState.zoom,
      dimmer: mlState.dimmer
    },
    pad_sensitivity: padSensitivity   // für den Pad-Sensitivity-Fader im Frontend
  };

  ws.send(JSON.stringify(msg));
}


/* --------------------------------------------------------
 * Main-Loop (Tick)
 * ------------------------------------------------------*/

function startMainLoop() {
  // Zustands-Broadcast läuft in eigenem, langsamerem Takt als DMX.
  setInterval(() => {
    try {
      stateTick();
    } catch (err) {
      if (DEBUG_ERRORS) console.error('[STATE] Fehler im Broadcast:', err);
    }
  }, 1000 / STATE_HZ);
  console.log(`[STATE] Zustands-Broadcast mit ${STATE_HZ} Hz aktiv.`);

  const intervalMs = 1000 / TICK_HZ;
  let lastTs = Date.now();
  let tickCount = 0;

  setInterval(() => {
    try {
      const now = Date.now();
      const dt = (now - lastTs) / 1000;
      lastTs = now;

      updateMlState(dt);
      mixSceneChannelsHTP();
      const universes = buildDmxUniverses();
      sendDmx(universes);

      if (DEBUG_TICKS) {
        tickCount++;
        if (tickCount % 100 === 0) {
          console.log('[TICK] dt=', dt.toFixed(3), 's');
        }
      }
    } catch (err) {
      if (DEBUG_ERRORS) {
        console.error('[TICK] Fehler im MainLoop:', err);
      }
      // Fehler wird geloggt, Loop läuft weiter.
    }
  }, intervalMs);
}

/* --------------------------------------------------------
 * Start – mit robustem Retry bei Startproblemen
 * ------------------------------------------------------*/

async function main() {
  // Endlosschleife, bis ein erfolgreicher Start gelingt
  while (true) {
    try {
      console.log('[INIT] Starte Lightserver-Initialisierung ...');

      // ggf. alten Pool sauber schließen
      if (pool) {
        try {
          await pool.end();
        } catch (e) {
          console.warn('[INIT] Fehler beim Beenden des bestehenden Pools (ignoriert):', e.message);
        }
        pool = null;
      }

      pool = mysql.createPool({
        host: DB_HOST,
        port: DB_PORT,
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10
      });

      await loadPatch();
      await loadPresets();
      await loadPositions();
      await loadPadSettings();
      setupWebSocketServer();
      startMainLoop();

      console.log('[INIT] Lightserver gestartet.');
      // Wenn wir hier sind, war der Start erfolgreich -> Schleife verlassen
      break;
    } catch (err) {
      console.error('[INIT] Fehler beim Start, neuer Versuch in 5 Sekunden:', err);
      // kleinen Delay, dann nächster Versuch
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Kein process.exit() mehr hier – nur loggen.
main().catch(err => {
  console.error('[FATAL] Unerwarteter Fehler in main():', err);
});
