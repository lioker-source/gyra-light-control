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

// Untergrenze der Pad-Empfindlichkeit. 0.05 heisst: voller Schwenk erst
// nach dem 20-fachen der normalen Zeit - fuer feines Setzen von Hand.
// Stand an drei Stellen einzeln auf 0.1, darunter auch beim Speichern:
// ein kleinerer Wert waere beim Schreiben in die DB wieder hochgezogen worden.
const PAD_SENSITIVITY_MIN = 0.05;


/* --------------------------------------------------------
 * Globale State-Objekte
 * ------------------------------------------------------*/

// Patch / DB-Strukturen
let dmxChannels = [];          // Liste aller DMX-Kanäle
let channelById = new Map();   // channel_id -> channel-Objekt (wird beim Reload getauscht)
let mlFixtures = [];           // Liste aller Movinglights
let fixtures = [];             // Geraete: Dimmer, LED-Pars, Movinglights

// Im Programmer ausgewaehlter Positions-Slot. Gehoert zum Programmer wie
// die Kanalwerte und wandert beim Speichern als Verweis ins Preset.
let programmerPosition = null;

/* Kanaele, fuer die in diesem Takt tatsaechlich jemand einen Wert gesetzt
 * hat - Preset mit Eintrag oder Programmer. Der Startwert aus fixed_value
 * zaehlt bewusst NICHT dazu. Nur damit laesst sich beim Zoom "gesetzter
 * Wert gewinnt, sonst Pad" entscheiden. */
const drivenChannels = new Set();

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

// Art-Net-Ausgabe zaehlen. Die Frage "geht ueberhaupt DMX raus?" laesst sich
// sonst nur am Node oder mit einem Sniffer beantworten.
let artnetSent = 0;
let artnetErrors = 0;
let artnetLastTs = 0;
let artnetLastError = null;
const SERVER_STARTED = Date.now();
const SERVER_VERSION = (() => {
  try { return require('./package.json').version; } catch { return 'unbekannt'; }
})();
let stateDirty = true;
let stateOrigin = null;
let lastStateSentTs = 0;


// Joystick-Geschwindigkeiten (−1..+1)
let mlPanSpeed  = 0;  // −1..+1
let mlTiltSpeed = 0;  // −1..+1
let mlMoveLastTs = 0; // Zeitpunkt der letzten Geschwindigkeitsvorgabe
// Empfindlichkeit, die der Absender fuer genau diese Bewegung vorgibt.
// null = es gilt die eingestellte Pad-Empfindlichkeit. Der Controller setzt
// hier einen festen Wert: sein Stickweg ist bereits die Dosierung, eine
// zweite daruebergelegte Skala macht ihn nur unberechenbar.
let mlMoveSensitivity = null;

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
    const [fx] = await conn.query(
      'SELECT * FROM fixtures WHERE active = 1 ORDER BY sort_order, id'
    );

    const newChannelById = new Map();
    for (const ch of channels) {
      newChannelById.set(ch.id, ch);
    }

    dmxChannels = channels;
    channelById = newChannelById;
    mlFixtures = ml;
    fixtures = fx;

    console.log(`[INIT] Loaded ${dmxChannels.length} DMX channels, ${fixtures.length} fixtures (davon ${mlFixtures.length} Movinglights).`);
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
    // Welche Presets auf diesen Slot verweisen. Das Frontend markiert den
    // Slot damit und warnt vor dem Loeschen.
    const usedBy = [];
    for (const [id, p] of presets) {
      if (p.meta.position_slot === slot) usedBy.push({ id, name: p.meta.name });
    }

    list.push({
      slot,
      name: pos ? (pos.name ?? null) : null,
      fade_time_sec: pos ? Number(pos.fade_time_sec) : null,
      occupied: !!pos,
      used_by: usedBy
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
        padSensitivity = clamp(val, PAD_SENSITIVITY_MIN, 1.0);
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
  const v = clamp(value, PAD_SENSITIVITY_MIN, 1.0);
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
  drivenChannels.clear();
  for (const ch of dmxChannels) {
    let maxVal = 0;

    // Beiträge aller Presets
    for (const [presetId, presetObj] of presets) {
      const level = presetFaderLevels.get(presetId) ?? 0;
      if (level <= 0) continue;

      if (!presetObj.values.has(ch.id)) continue;
      drivenChannels.add(ch.id);
      const contribution = level * presetObj.values.get(ch.id);
      if (contribution > maxVal) maxVal = contribution;
    }

    // Programmer (zweiter Tab) – HTP
    if (programmerValues.has(ch.id)) drivenChannels.add(ch.id);
    const progVal = programmerValues.get(ch.id) ?? 0;
    if (progVal > maxVal) maxVal = progVal;

    // Startwert (fixed_value): gilt, solange den Kanal niemand anfasst.
    // Frueher wurde er ganz am Ende ueber alles geschrieben - Shutter,
    // Farbtemperatur und die Weiss-Segmente waren damit im Programmer
    // unbedienbar. Jetzt zaehlt er wie ein weiterer HTP-Beitrag, ausser
    // der Programmer hat fuer den Kanal einen eigenen Eintrag: dann
    // gewinnt der, auch wenn er 0 ist (Licht ausschalten muss moeglich
    // bleiben). `programmerValues` speichert auch die 0, deshalb ist
    // "nicht angefasst" von "auf 0 gezogen" unterscheidbar.
    // `drivenChannels` statt nur des Programmers: sonst gewinnt der
    // Startwert gegen ein Preset, das den Kanal bewusst NIEDRIGER setzt
    // (Segmente dunkler, Farbtemperatur kaelter). Genau das kam beim
    // Playback nicht durch.
    if (ch.fixed_value != null && !drivenChannels.has(ch.id)) {
      const startNorm = clamp(ch.fixed_value / 255, 0, 1);
      if (startNorm > maxVal) maxVal = startNorm;
    }

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
    mlMoveSensitivity = null;
    console.warn('[ML] Keine Bewegungsdaten mehr - Geschwindigkeit auf 0 gesetzt.');
  }

  // 3) Joystick-Steuerung (relativ), wenn kein aktiver Fade
  if (!mlPositionFade) {
    // padSensitivity skaliert die Geschwindigkeit: 1.0 = volle Fahrt in
    // JOYSTICK_FULL_RANGE_SEC, 0.1 = zehnmal langsamer fuer feines Setzen.
    // Der Wert wurde bisher geladen, gespeichert und gesendet, aber nirgends
    // angewendet - der Fader im Frontend war damit wirkungslos.
    // Gibt der Absender eine Empfindlichkeit mit, gilt seine - sonst die
    // eingestellte. So bleibt der Controller vom Fader unberuehrt.
    const wirksameSens = mlMoveSensitivity != null ? mlMoveSensitivity : padSensitivity;
    const speedScale = wirksameSens / JOYSTICK_FULL_RANGE_SEC;

    // Pan
    if (Math.abs(mlPanSpeed) > JOYSTICK_DEADZONE) {
      mlState.pan = clamp(mlState.pan + mlPanSpeed * dt * speedScale, 0, 1);
    }

    // Tilt
    if (Math.abs(mlTiltSpeed) > JOYSTICK_DEADZONE) {
      mlState.tilt = clamp(mlState.tilt + mlTiltSpeed * dt * speedScale, 0, 1);
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
      // Steht im Programmer oder in einem hochgezogenen Preset ein
      // Zoomwert, gilt der. Sonst fuehrt das Live-Pad.
      if (drivenChannels.has(zoomChannel.id)) {
        set8bit(zoomChannel, outputChannels.get(zoomChannel.id) ?? 0, false);
      } else {
        set8bit(zoomChannel, mlState.zoom, false);
      }
    }

    if (dimmerChannel) {
      // Der ML-Dimmer ist eine Intensität und gehoert damit unter den
      // Master. Der Szenenanteil in set8bit kommt aus outputChannels und
      // wurde dort bereits gemastert.
      set8bit(dimmerChannel, applyMaster(mlState.dimmer, dimmerChannel), true);
    }
  }
  
  // Der frueher hier stehende Schritt 3 (fixed_value ueber alles schreiben)
  // ist entfallen: fixed_value geht jetzt als Startwert in die HTP-Mischung
  // ein (siehe mixSceneChannelsHTP) und bleibt damit ueberschreibbar.

  return universes;
}

function sendDmx(universes) {
  if (!universes || universes.size === 0) return;

  const socket = getArtnetSocket();

  for (const [uni, dmxArray] of universes) {
    const packet = buildArtDmxPacket(uni, dmxArray);

    socket.send(packet, 0, packet.length, ARTNET_PORT, ARTNET_TARGET, (err) => {
      if (err) {
        artnetErrors++;
        artnetLastError = err.message;
        if (DEBUG_ERRORS) console.error('[ARTNET] Send-Fehler (Universe', uni, '):', err);
        return;
      }
      artnetSent++;
      artnetLastTs = Date.now();
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
function applyMlMove(panSpeed, tiltSpeed, sensitivity) {
  const p = typeof panSpeed  === 'number' ? clamp(panSpeed,  -1, 1) : 0;
  const t = typeof tiltSpeed === 'number' ? clamp(tiltSpeed, -1, 1) : 0;

  mlMoveSensitivity = typeof sensitivity === 'number'
    ? clamp(sensitivity, PAD_SENSITIVITY_MIN, 1.0)
    : null;

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
/**
 * Positions-Slot aus dem Cache anfahren, ohne Datenbankzugriff.
 * Gebraucht von preset.fader und programmer.position - beide duerfen den
 * 40-Hz-Takt nicht auf eine Abfrage warten lassen.
 */
function recallSlot(slot) {
  const pos = mlPositions.get(slot);
  if (!pos) return false;
  startPositionFade(
    clamp(Number(pos.pan_norm), 0, 1),
    clamp(Number(pos.tilt_norm), 0, 1),
    clamp(Number(pos.zoom_norm), 0, 1),
    Number(pos.fade_time_sec) || 0
  );
  return true;
}

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
  'preset.fader', 'preset.save', 'preset.delete', 'preset.update',
  'programmer.channel', 'programmer.clear', 'programmer.load_preset',
  'programmer.position',
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
    programmer_position: programmerPosition,
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
 * Patch-Editor (PROTOKOLL.md §3.8)
 *
 * Der Server kennt die Bauarten als Vorlage und legt die Kanaele selbst an.
 * Der Client gibt nur Name, Bauart, Universe und Startadresse vor.
 *
 * Wichtig fuer die Presets: sie zeigen auf Kanal-IDs.
 *   - Adresse, Name oder Universe aendern  -> IDs bleiben, Presets bleiben.
 *   - Bauart aendern oder Fixture loeschen -> Kanaele werden neu angelegt,
 *     `light_preset_values` haengt mit ON DELETE CASCADE daran und verliert
 *     die Werte dieser Kanaele. Das Frontend warnt vorher.
 * ------------------------------------------------------*/

const FIXTURE_TYPES = {
  dimmer: {
    label: 'Dimmer', group: 'dimmer',
    channels: [{ role: 'dimmer', label: 'Dimmer', intensity: true }]
  },
  dimmer_shutter: {
    label: 'Dimmer + Shutter', group: 'dimmer',
    channels: [
      { role: 'dimmer', label: 'Dimmer', intensity: true },
      { role: 'shutter', label: 'Shutter', fixed: 255 }
    ]
  },
  rgbw: {
    label: 'LED RGBW', group: 'led',
    channels: [
      { role: 'r', label: 'Rot',   intensity: true },
      { role: 'g', label: 'Gruen', intensity: true },
      { role: 'b', label: 'Blau',  intensity: true },
      { role: 'w', label: 'Weiss', intensity: true }
    ]
  },
  rgbaw: {
    label: 'LED RGBAW', group: 'led',
    channels: [
      { role: 'r', label: 'Rot',   intensity: true },
      { role: 'g', label: 'Gruen', intensity: true },
      { role: 'b', label: 'Blau',  intensity: true },
      { role: 'a', label: 'Amber', intensity: true },
      { role: 'w', label: 'Weiss', intensity: true }
    ]
  },
  moving_head: {
    label: 'Hero Wash 300 TW', group: 'ml',
    channels: [
      { role: 'pan',         label: 'Pan' },
      { role: 'pan_fine',    label: 'Pan Fine' },
      { role: 'tilt',        label: 'Tilt' },
      { role: 'tilt_fine',   label: 'Tilt Fine' },
      { role: 'pt_speed',    label: 'P/T Speed', fixed: 0 },
      { role: 'zoom',        label: 'Zoom' },
      { role: 'dimmer',      label: 'Dimmer', intensity: true },
      { role: 'strobe',      label: 'Stroboskop', fixed: 255 },
      { role: 'cw1',         label: 'Kaltweiss 1', fixed: 255, intensity: true },
      { role: 'ww1',         label: 'Warmweiss 1', fixed: 255, intensity: true },
      { role: 'cw2',         label: 'Kaltweiss 2', fixed: 255, intensity: true },
      { role: 'ww2',         label: 'Warmweiss 2', fixed: 255, intensity: true },
      { role: 'cw3',         label: 'Kaltweiss 3', fixed: 255, intensity: true },
      { role: 'ww3',         label: 'Warmweiss 3', fixed: 255, intensity: true },
      { role: 'ctc',         label: 'Farbtemperatur', fixed: 128 },
      { role: 'seg_pattern', label: 'Segment-Muster', fixed: 0 },
      { role: 'seg_fade',    label: 'Muster-Uebergang', fixed: 0 },
      { role: 'zoom_auto',   label: 'Zoom-Automatik', fixed: 0 },
      { role: 'pt_auto',     label: 'P/T-Automatik', fixed: 0 }
    ]
  }
};

function typeList() {
  return Object.entries(FIXTURE_TYPES).map(([key, t]) => ({
    type: key, label: t.label, channel_count: t.channels.length
  }));
}

/** Kanaele eines Fixtures aus der Vorlage anlegen. */
async function createChannelsFor(conn, fixtureId, name, type, universe, startAddress) {
  const tpl = FIXTURE_TYPES[type];
  const ids = [];
  for (let i = 0; i < tpl.channels.length; i++) {
    const c = tpl.channels[i];
    const [res] = await conn.query(
      'INSERT INTO dmx_channels (name, universe, dmx_address, channel_group, fixture_id, role, sort_order, fixed_value, is_intensity) ' +
      'VALUES (?,?,?,?,?,?,?,?,?)',
      [name + ' ' + c.label, universe, startAddress + i, tpl.group, fixtureId, c.role,
       startAddress * 10 + i, c.fixed ?? null, c.intensity ? 1 : 0]
    );
    ids.push({ role: c.role, id: res.insertId });
  }

  // Movinglight zusaetzlich in ml_fixtures verdrahten.
  if (type === 'moving_head') {
    const byRole = Object.fromEntries(ids.map(x => [x.role, x.id]));
    await conn.query(
      'INSERT INTO ml_fixtures (name, pan_channel_id, pan_fine_channel_id, tilt_channel_id, ' +
      'tilt_fine_channel_id, zoom_channel_id, dimmer_channel_id, pan_invert, tilt_invert, active, sort_order) ' +
      'VALUES (?,?,?,?,?,?,?,1,0,1,10)',
      [name, byRole.pan, byRole.pan_fine, byRole.tilt, byRole.tilt_fine, byRole.zoom, byRole.dimmer]
    );
  }
  return ids;
}

/** Kanaele eines Fixtures entfernen. ml_fixtures zuerst (Fremdschluessel RESTRICT). */
async function dropChannelsFor(conn, fixtureId) {
  const [chans] = await conn.query('SELECT id FROM dmx_channels WHERE fixture_id = ?', [fixtureId]);
  if (!chans.length) return;
  const ids = chans.map(c => c.id);
  await conn.query('DELETE FROM ml_fixtures WHERE pan_channel_id IN (?)', [ids]);
  // light_preset_values haengt mit ON DELETE CASCADE dran.
  await conn.query('DELETE FROM dmx_channels WHERE fixture_id = ?', [fixtureId]);
}

async function handlePatchFixture(ws, msg) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (msg.type === 'patch.fixture.delete') {
      if (msg.id == null) throw new Error('id fehlt');
      await dropChannelsFor(conn, msg.id);
      await conn.query('DELETE FROM fixtures WHERE id = ?', [msg.id]);

    } else if (msg.type === 'patch.fixture.create') {
      const t = msg.fixture_type;
      if (!FIXTURE_TYPES[t]) throw new Error('Unbekannte Bauart: ' + t);
      const name = String(msg.name || FIXTURE_TYPES[t].label).trim();
      const universe = Number(msg.universe ?? ARTNET_UNIVERSE_DEFAULT);
      const start = Number(msg.start_address);
      if (!(start >= 1 && start <= DMX_UNIVERSE_SIZE)) throw new Error('Startadresse ausserhalb 1-512');

      const [res] = await conn.query(
        'INSERT INTO fixtures (name, fixture_type, universe, start_address, sort_order, active) VALUES (?,?,?,?,?,1)',
        [name, t, universe, start, start]
      );
      await createChannelsFor(conn, res.insertId, name, t, universe, start);

    } else {
      const [rows] = await conn.query('SELECT * FROM fixtures WHERE id = ?', [msg.id]);
      if (!rows.length) throw new Error('Fixture ' + msg.id + ' gibt es nicht');
      const alt = rows[0];

      const name     = String(msg.name ?? alt.name).trim();
      const universe = Number(msg.universe ?? alt.universe);
      const start    = Number(msg.start_address ?? alt.start_address);
      const t        = msg.fixture_type ?? alt.fixture_type;
      if (!FIXTURE_TYPES[t]) throw new Error('Unbekannte Bauart: ' + t);
      if (!(start >= 1 && start <= DMX_UNIVERSE_SIZE)) throw new Error('Startadresse ausserhalb 1-512');

      await conn.query(
        'UPDATE fixtures SET name = ?, fixture_type = ?, universe = ?, start_address = ?, sort_order = ? WHERE id = ?',
        [name, t, universe, start, start, msg.id]
      );

      if (t !== alt.fixture_type) {
        // Bauart gewechselt: Kanaele passen nicht mehr, also neu anlegen.
        await dropChannelsFor(conn, msg.id);
        await createChannelsFor(conn, msg.id, name, t, universe, start);
      } else {
        // Nur verschoben oder umbenannt: IDs behalten, damit Presets und
        // die ml_fixtures-Verdrahtung erhalten bleiben.
        const tpl = FIXTURE_TYPES[t];
        const [chans] = await conn.query(
          'SELECT id, role FROM dmx_channels WHERE fixture_id = ? ORDER BY dmx_address', [msg.id]
        );
        for (const c of chans) {
          const i = tpl.channels.findIndex(x => x.role === c.role);
          if (i < 0) continue;
          await conn.query(
            'UPDATE dmx_channels SET name = ?, universe = ?, dmx_address = ?, sort_order = ? WHERE id = ?',
            [name + ' ' + tpl.channels[i].label, universe, start + i, start * 10 + i, c.id]
          );
        }
        if (t === 'moving_head') {
          await conn.query(
            'UPDATE ml_fixtures SET name = ? WHERE pan_channel_id IN (SELECT id FROM (SELECT id FROM dmx_channels WHERE fixture_id = ?) x)',
            [name, msg.id]
          );
        }
      }
    }

    await conn.commit();
    await loadPatch();
    await loadPresets();
    broadcast(buildPatchMessage());
    broadcastLibrary();
    console.log('[PATCH] ' + msg.type + ' ausgefuehrt.');
  } catch (err) {
    await conn.rollback();
    console.error('[PATCH] Fehlgeschlagen:', err.message);
    ws.send(JSON.stringify({ type: 'error', code: 'patch_failed',
      ref: msg.type, message: 'Patch konnte nicht geaendert werden: ' + err.message }));
  } finally {
    conn.release();
  }
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
      applyMlMove(msg.pan_speed, msg.tilt_speed, msg.sensitivity);
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

    case 'diag.request': {
      // Diagnose fuer das Verbindungsfenster im Frontend. Bewusst auf
      // Anfrage und nicht im state-Broadcast: die Zahlen braucht nur, wer
      // gerade hinsieht, und der Broadcast laeuft mit STATE_HZ.
      // Die Datenbank wird gefragt, nicht geraten: ein SELECT 1 kostet hier
      // nichts und beantwortet die Frage wirklich.
      let dbOk = false, dbFehler = null;
      try {
        const conn = await pool.getConnection();
        try { await conn.query('SELECT 1'); dbOk = true; }
        finally { conn.release(); }
      } catch (err) { dbFehler = err.message; }

      ws.send(JSON.stringify({
        type: 'diag',
        server: {
          version: SERVER_VERSION,
          started: SERVER_STARTED,
          now: Date.now(),
          clients: wss ? wss.clients.size : 1,
          tick_hz: TICK_HZ,
          state_hz: STATE_HZ,
          state_seq: stateSeq
        },
        artnet: {
          mode: ARTNET_MODE,
          target: ARTNET_TARGET,
          port: ARTNET_PORT,
          universe: ARTNET_UNIVERSE_DEFAULT,
          sync: ARTNET_SYNC,
          sent: artnetSent,
          errors: artnetErrors,
          last_ts: artnetLastTs,
          last_error: artnetLastError
        },
        db: { ok: dbOk, error: dbFehler, name: process.env.DB_NAME || 'lichtsteuerung' }
      }));
      break;
    }

    case 'settings.pad_sensitivity':
    case 'ml_sensitivity':                     // v1-Name
      // { type: 'ml_sensitivity', value }
      if (typeof msg.value === 'number') {
        const val = clamp(msg.value, PAD_SENSITIVITY_MIN, 1.0);
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
      const neu = clamp(lvl ?? 0, 0, 1);
      const alt = presetFaderLevels.get(msg.preset_id) ?? 0;
      presetFaderLevels.set(msg.preset_id, neu);

      // Verweist das Preset auf einen Positions-Slot, faehrt der Kopf ihn
      // beim Aufziehen an - einmalig beim Uebergang von 0 auf mehr, nicht
      // bei jeder Faderbewegung. Eine Position ist nicht dimmbar, sie wird
      // ausgeloest (PROTOKOLL.md §3.3).
      const preset = presets.get(msg.preset_id);
      const slot = preset?.meta?.position_slot;
      if (slot != null && alt === 0 && neu > 0) {
        if (recallSlot(slot)) {
          console.log(`[PRESET] ${preset.meta.name}: faehrt Position ${slot} an.`);
        }
      }
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

    // Position im Programmer waehlen (PROTOKOLL.md §3.4). Der Kopf faehrt
    // sie gleich an, damit man sieht, was man speichern wird.
    case 'programmer.position': {
      const slot = msg.slot == null ? null : Number(msg.slot);
      if (slot !== null && !mlPositions.has(slot)) {
        ws.send(JSON.stringify({ type: 'error', code: 'not_found',
          ref: 'programmer.position', message: `Slot ${slot} ist nicht belegt.` }));
        return;
      }
      programmerPosition = slot;
      if (slot !== null) recallSlot(slot);
      break;
    }

    case 'programmer.clear':
      // Ohne diesen Weg blieb ein einmal gesetzter Wert bis zum Neustart
      // stehen - es gab schlicht keine Moeglichkeit, auf 0 zurueckzukommen.
      programmerValues.clear();
      programmerPosition = null;
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

    case 'patch.fixture.create':
    case 'patch.fixture.update':
    case 'patch.fixture.delete':
      await handlePatchFixture(ws, msg);
      break;

    case 'preset.update':
      await handlePresetUpdate(ws, msg);
      break;

    case 'programmer.load_preset':
      handleProgrammerLoadPreset(ws, msg);
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
    // Verweise aus Presets loesen, damit kein Preset auf einen leeren
    // Slot zeigt. Das Frontend warnt vorher, welche betroffen sind.
    await conn.query('UPDATE light_presets SET position_slot = NULL WHERE position_slot = ?', [slot]);
    const [res] = await conn.query('DELETE FROM ml_positions WHERE button_index = ?', [slot]);
    if (!res.affectedRows) {
      ws.send(JSON.stringify({ type: 'error', code: 'not_found',
        ref: 'position.delete', message: `Slot ${slot} ist nicht belegt.` }));
      return;
    }
    await loadPositions();
    await loadPresets();      // position_slot kann sich geaendert haben
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
 * Preset umbenennen, ohne die gespeicherten Kanalwerte anzufassen
 * (PROTOKOLL.md §3.3).
 *
 * Warum ein eigener Befehl: `preset.save` mit `preset_id` loescht die
 * bestehenden `light_preset_values` und schreibt sie neu - entweder aus
 * `channels` oder aus dem Programmer. Ein blosses Umbenennen ueber
 * `preset.save` wuerde den Inhalt des Presets also mit dem aktuellen
 * Programmer ueberschreiben. Dieselbe Trennung wie bei position.update.
 */
async function handlePresetUpdate(ws, msg) {
  const id = msg.preset_id;
  const name = typeof msg.name === 'string' ? msg.name.trim() : '';
  if (id == null || name === '') {
    ws.send(JSON.stringify({ type: 'error', code: 'bad_request',
      ref: 'preset.update', message: 'preset_id oder name fehlt.' }));
    return;
  }

  const conn = await pool.getConnection();
  try {
    const [res] = await conn.query(
      'UPDATE light_presets SET name = ? WHERE id = ? AND active = 1',
      [name, id]
    );
    if (!res.affectedRows) {
      ws.send(JSON.stringify({ type: 'error', code: 'not_found',
        ref: 'preset.update', message: `Preset ${id} gibt es nicht.` }));
      return;
    }
    await loadPresets();
    console.log(`[PRESET] Preset ${id} umbenannt in "${name}".`);
    broadcastLibrary();
  } catch (err) {
    console.error('[PRESET] Fehler beim Umbenennen:', err);
    ws.send(JSON.stringify({ type: 'error', code: 'update_failed',
      ref: 'preset.update', message: 'Preset konnte nicht umbenannt werden.' }));
  } finally {
    conn.release();
  }
}

/**
 * Ein Preset zum Bearbeiten in den Programmer holen (PROTOKOLL.md §3.4).
 * Der Programmer wird dabei ersetzt, nicht ergaenzt - sonst mischt sich der
 * vorherige Stand unbemerkt in das Preset, das gleich zurueckgespeichert wird.
 * Die Werte liegen serverseitig schon normiert vor; der Client bekommt sie
 * ueber den naechsten state-Broadcast und muss nichts nachladen.
 */
function handleProgrammerLoadPreset(ws, msg) {
  const preset = presets.get(msg.preset_id);
  if (!preset) {
    ws.send(JSON.stringify({ type: 'error', code: 'not_found',
      ref: 'programmer.load_preset', message: `Preset ${msg.preset_id} gibt es nicht.` }));
    return;
  }
  programmerValues.clear();
  for (const [channelId, value] of preset.values) {
    programmerValues.set(channelId, value);   // auch 0: siehe handleSavePreset
  }
  programmerPosition = preset.meta.position_slot ?? null;
  if (programmerPosition != null) recallSlot(programmerPosition);
  console.log(`[PROG] Preset ${msg.preset_id} in den Programmer geladen (${programmerValues.size} Kanaele).`);
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
    // Position als Verweis auf einen Slot. Ohne Angabe uebernimmt das
    // Preset die im Programmer gewaehlte Position - analog zu den Kanaelen.
    const positionSlot = (msg.position_slot !== undefined)
      ? (msg.position_slot === null ? null : Number(msg.position_slot))
      : (Array.isArray(msg.channels) ? null : programmerPosition);

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
        'INSERT INTO light_presets (name, page, fader_index, position_slot, active) VALUES (?, ?, ?, ?, 1)',
        [name, page, faderIndex, positionSlot]
      );
      presetId = res.insertId;
    } else {
      await conn.query(
        'UPDATE light_presets SET name = ?, page = ?, fader_index = ?, position_slot = ? WHERE id = ?',
        [name, page, faderIndex, positionSlot, presetId]
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
      // Alles uebernehmen, was im Programmer angefasst wurde - auch die 0.
      // Seit fixed_value ein Startwert ist, bedeutet eine gespeicherte 0
      // "dieser Kanal bleibt aus" und ist damit eine echte Aussage. Wuerde
      // sie weggelassen, kaeme beim Playback der Startwert zurueck.
      values = [];
      for (const [channelId, val] of programmerValues) {
        values.push([presetId, channelId, clamp(val, 0, 1)]);
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

    // Kam der Inhalt aus dem Programmer, ist er mit dem Speichern verbraucht:
    // der Look steht jetzt im Preset und liegt sonst doppelt uebereinander.
    // Das macht der Server, nicht der Client - schickte der Client ein
    // eigenes programmer.clear hinterher, koennte es waehrend des noch
    // laufenden Datenbankschreibens greifen und ein leeres Preset erzeugen.
    if (source === 'programmer') {
      programmerValues.clear();
      programmerPosition = null;
    }

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
      fader_index: p.meta.fader_index,
      position_slot: p.meta.position_slot ?? null
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
    fixture_id: ch.fixture_id ?? null,
    role: ch.role ?? null,
    fixed_value: ch.fixed_value ?? null,
    is_intensity: !!ch.is_intensity
  }));
}

/** Patch: Kanaele und Movinglights (PROTOKOLL.md §4.1). */
function buildPatchMessage() {
  return {
    type: 'patch',
    fixture_types: typeList(),
    fixtures: fixtures.map(f => ({
      id: f.id,
      name: f.name,
      type: f.fixture_type,
      universe: f.universe ?? ARTNET_UNIVERSE_DEFAULT,
      start_address: f.start_address,
      channel_count: (FIXTURE_TYPES[f.fixture_type]?.channels.length) ?? 0
    })),
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
