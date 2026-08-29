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

// --------------------------------------------------------
// Globale Error-Handler für maximale Robustheit
// --------------------------------------------------------

process.on('unhandledRejection', (reason, p) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
  // absichtlich KEIN process.exit() – Prozess läuft weiter,
  // Supervisor wie pm2/systemd kümmert sich im Worst Case.
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
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'lichtsteuerung';

const WS_PORT = Number(process.env.WS_PORT || 8080);
const TICK_HZ = Number(process.env.TICK_HZ || 40);

const ARTNET_HOST = process.env.ARTNET_HOST || '127.0.0.1';
const ARTNET_UNIVERSE_DEFAULT = Number(process.env.ARTNET_UNIVERSE || 0);

const DMX_UNIVERSE_SIZE = 512;
let artnetSocket = null;

// Default-Pad-Sensitivität (Frontend-Skala 0.1..1.0)
const DEFAULT_PAD_SENSITIVITY = Number(process.env.PAD_SENSITIVITY || 1.0);


/* --------------------------------------------------------
 * Globale State-Objekte
 * ------------------------------------------------------*/

// Patch / DB-Strukturen
let dmxChannels = [];          // Liste aller DMX-Kanäle
let channelById = new Map();   // channel_id -> channel-Objekt
let mlFixtures = [];           // Liste aller Movinglights

let presets = new Map();       // preset_id -> { meta, values: Map(channel_id -> max_value) }

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


// Joystick-Geschwindigkeiten (−1..+1)
let mlPanSpeed  = 0;  // −1..+1
let mlTiltSpeed = 0;  // −1..+1

// Pad-Sensitivität (Frontend-Skala 0.1..1.0, beeinflusst die vom Client geschickten Speeds)
let padSensitivity = DEFAULT_PAD_SENSITIVITY;

// Parameter für Joystick-Verhalten
const JOYSTICK_FULL_RANGE_SEC = Number(process.env.JOY_FULL_RANGE_SEC || 2.0);
// z.B. 2.0 ⇒ bei Vollauslenkung braucht er ca. 2s für 0→1
const JOYSTICK_DEADZONE = 0.05;

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
    // DMX-Kanäle
    const [channels] = await conn.query(
      'SELECT * FROM dmx_channels ORDER BY sort_order, id'
    );
    dmxChannels = channels;
    channelById.clear();
    for (const ch of dmxChannels) {
      channelById.set(ch.id, ch);
    }

    // ML-Fixtures
    const [ml] = await conn.query(
      'SELECT * FROM ml_fixtures WHERE active = 1 ORDER BY sort_order, id'
    );
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

    outputChannels.set(ch.id, clamp(maxVal, 0, 1));
  }
}

/* --------------------------------------------------------
 * Movinglight-Update (Fades, LTP)
 * ------------------------------------------------------*/

function updateMlState(dt) {
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
	
	// Dimmer weich zum Zielwert fahren
	const DIMMER_SMOOTHING_SEC = 0.12;

	const factor = Math.min(1, dt / DIMMER_SMOOTHING_SEC);
	mlState.dimmer += (mlDimmerTarget - mlState.dimmer) * factor;
  }

  // 2) Joystick-Steuerung (relativ), wenn kein aktiver Fade
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

  // Zoom & Dimmer kommen direkt aus mlState.zoom / mlState.dimmer (LTP aus ml_live)
}


/* --------------------------------------------------------
 * DMX / Art-Net
 * ------------------------------------------------------*/

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

  // Sequence, Physical (ignorieren wir)
  buf[12] = 0x00; // Sequence
  buf[13] = 0x00; // Physical

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
function getArtnetSocket() {
  if (!artnetSocket) {
    artnetSocket = dgram.createSocket('udp4');
    artnetSocket.on('error', (err) => {
      console.error('[ARTNET] Socket-Fehler:', err);
      // Socket offen lassen; Art-Net-Ausgabe kann temporär gestört sein.
    });
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

    set16bit(panChannel, panFineChannel, 1 - mlState.pan);
	set16bit(tiltChannel, tiltFineChannel, mlState.tilt);

    if (zoomChannel) {
      set8bit(zoomChannel, mlState.zoom, false);
    }

    if (dimmerChannel) {
      set8bit(dimmerChannel, mlState.dimmer, true);
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

    socket.send(packet, 0, packet.length, 6454, ARTNET_HOST, (err) => {
      if (err && DEBUG_ERRORS) {
        console.error('[ARTNET] Send-Fehler (Universe', uni, '):', err);
      }
    });
  }
}


/* --------------------------------------------------------
 * WebSocket-Server
 * ------------------------------------------------------*/

function setupWebSocketServer() {
  wss = new WebSocket.Server({ port: WS_PORT });
  console.log(`[WS] Server läuft auf ws://0.0.0.0:${WS_PORT}`);

  // Server-weite Fehler
  wss.on('error', (err) => {
    console.error('[WS] Server-Fehler:', err);
  });

  wss.on('connection', (ws) => {
    console.log('[WS] Client verbunden');

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
      } catch (err) {
        console.error('[WS] Fehler beim Verarbeiten der Nachricht:', err);
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client getrennt');
    });

    // Presets frisch laden und Initialzustand schicken
    (async () => {
      try {
        await loadPresets();
        await loadPadSettings(); // Pad-Sensitivität auch beim Connect frisch holen
      } catch (err) {
        console.error('[WS] Fehler beim Laden von Presets/Settings für init_state:', err);
      }
      sendInitState(ws);
    })();
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

/* --------------------------------------------------------
 * WebSocket: Nachrichten behandeln
 * ------------------------------------------------------*/

async function handleClientMessage(ws, msg) {
  if (DEBUG_WS_IN) {
    console.log('[WS-IN]', msg);
  }
  switch (msg.type) {
    case 'ml_live':
      // { type: 'ml_live', mode, pan_speed, tilt_speed, zoom, dimmer }
      if (mlPositionFade) {
        mlPositionFade = null;
      }

      if (msg.mode === 'velocity') {
        if (typeof msg.pan_speed === 'number') {
          // Frontend skaliert bereits mit padSensitivity,
          // hier trotzdem clampen:
          mlPanSpeed = clamp(msg.pan_speed, -1, 1);
        } else {
          mlPanSpeed = 0;
        }
        if (typeof msg.tilt_speed === 'number') {
          mlTiltSpeed = clamp(msg.tilt_speed, -1, 1);
        } else {
          mlTiltSpeed = 0;
        }
      } else {
        if (typeof msg.pan === 'number') {
          mlState.pan = clamp(msg.pan, 0, 1);
        }
        if (typeof msg.tilt === 'number') {
          mlState.tilt = clamp(msg.tilt, 0, 1);
        }
      }

      if (typeof msg.zoom === 'number') {
        mlState.zoom = clamp(msg.zoom, 0, 1);
      }
      if (typeof msg.dimmer === 'number') {
	    mlDimmerTarget = clamp(msg.dimmer, 0, 1);
	  }
      break;

    case 'ml_sensitivity':
      // { type: 'ml_sensitivity', value }
      if (typeof msg.value === 'number') {
        const val = clamp(msg.value, 0.1, 1.0);
        padSensitivity = val;
        await savePadSensitivity(val);
        // optional: an alle Clients broadcasten
        broadcast({ type: 'pad_sensitivity', value: val });
      }
      break;

    case 'preset_fader':
      // { type: 'preset_fader', preset_id, value }
      if (msg.preset_id == null) return;
      presetFaderLevels.set(msg.preset_id, clamp(msg.value ?? 0, 0, 1));
      break;

    case 'programmer_channel':
      // { type: 'programmer_channel', channel_id, value }
      if (msg.channel_id == null) return;
      programmerValues.set(msg.channel_id, clamp(msg.value ?? 0, 0, 1));
      break;

    case 'save_preset':
      // { type: 'save_preset', preset_id|null, name, page, fader_index, channels:[{channel_id,max_value}] }
      await handleSavePreset(ws, msg);
      break;

    // Neue Message-Typen für Positions-Buttons
    case 'ml_pos_store':
      // { type: 'ml_pos_store', slot, pan, tilt, zoom }
      await handleMlPosStore(ws, msg);
      break;

    case 'ml_pos_recall':
      // { type: 'ml_pos_recall', slot }
      await handleMlPosRecall(ws, msg);
      break;

    // Alte Typen bleiben optional für Kompatibilität:
    case 'save_ml_position':
      await handleSaveMlPositionLegacy(ws, msg);
      break;

    case 'recall_ml_position':
      await handleRecallMlPositionLegacy(ws, msg);
      break;

    default:
      console.warn('[WS] Unbekannter Nachrichtentyp:', msg.type);
  }
}

/* --------------------------------------------------------
 * Presets speichern
 * ------------------------------------------------------*/

async function handleSavePreset(ws, msg) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let presetId = msg.preset_id || null;
    const name = msg.name || 'Preset';
    const page = msg.page || 1;
    const faderIndex = msg.fader_index || 1;

    if (!presetId) {
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

    if (Array.isArray(msg.channels)) {
      const values = msg.channels
        .filter(ch => ch.channel_id != null && ch.max_value != null)
        .map(ch => [
          presetId,
          ch.channel_id,
          clamp(ch.max_value, 0, 1)
        ]);

      if (values.length > 0) {
        await conn.query(
          'INSERT INTO light_preset_values (preset_id, channel_id, max_value) VALUES ?',
          [values]
        );
      }
    }

    await conn.commit();

    await loadPresets();

    ws.send(JSON.stringify({ type: 'preset_saved', preset_id: presetId }));
    console.log(`[PRESET] Preset ${presetId} gespeichert (${name})`);
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

    const fade = 1.0; // Standard-Fadezeit in Sekunden (konfigurierbar machbar)

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

    // Für maximale Robustheit: erst mal hard-setten
    mlPositionFade = null;
    mlState.pan    = targetPan;
    mlState.tilt   = targetTilt;
    mlState.zoom   = targetZoom;
    // Dimmer lassen wir wie er ist (Show-Situation)

    // Falls du später wieder Fades willst, könntest du hier zusätzlich
    // mlPositionFade setzen und im Tick langsam hin interpolieren.

    // Client informieren, damit seine GUI synchron ist
    const reply = {
      type: 'ml_position_recalled',
      slot,
      ml_state: {
        pan:    mlState.pan,
        tilt:   mlState.tilt,
        zoom:   mlState.zoom,
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
 * ML-Positionen – Legacy-Handler (save_ml_position / recall_ml_position)
 * ------------------------------------------------------*/

async function handleSaveMlPositionLegacy(ws, msg) {
  const conn = await pool.getConnection();
  try {
    const { button_index, name, fade_time_sec } = msg;
    if (button_index == null) {
      throw new Error('button_index fehlt');
    }

    // Ebenfalls nur den aktuellen Server-Stand verwenden
    const pn = clamp(mlState.pan, 0, 1);
    const tn = clamp(mlState.tilt, 0, 1);
    const zn = clamp(mlState.zoom, 0, 1);
    const fade = fade_time_sec != null ? Math.max(0, fade_time_sec) : 1.0;

    const [rows] = await conn.query(
      'SELECT id FROM ml_positions WHERE button_index = ?',
      [button_index]
    );

    const effectiveName = name || 'Pos';

    if (rows.length) {
      await conn.query(
        'UPDATE ml_positions SET name = ?, pan_norm = ?, tilt_norm = ?, zoom_norm = ?, fade_time_sec = ?, active = 1 WHERE button_index = ?',
        [effectiveName, pn, tn, zn, fade, button_index]
      );
    } else {
      await conn.query(
        'INSERT INTO ml_positions (name, button_index, pan_norm, tilt_norm, zoom_norm, fade_time_sec, active) VALUES (?,?,?,?,?,?,1)',
        [effectiveName, button_index, pn, tn, zn, fade]
      );
    }

    ws.send(JSON.stringify({ type: 'ml_position_saved', button_index }));
    console.log(
      `[ML] (Legacy) Position auf Button ${button_index} gespeichert (${effectiveName}) – pan=${pn.toFixed(3)}, tilt=${tn.toFixed(3)}, zoom=${zn.toFixed(3)}`
    );
  } catch (err) {
    console.error('[ML] Fehler beim Speichern der Position (Legacy):', err);
    ws.send(JSON.stringify({ type: 'error', message: 'ML-Position konnte nicht gespeichert werden.' }));
  } finally {
    conn.release();
  }
}


async function handleRecallMlPositionLegacy(ws, msg) {
  const conn = await pool.getConnection();
  try {
    const { button_index } = msg;
    if (button_index == null) {
      throw new Error('button_index fehlt');
    }

    const [rows] = await conn.query(
      'SELECT * FROM ml_positions WHERE button_index = ? AND active = 1',
      [button_index]
    );
    if (!rows.length) {
      ws.send(JSON.stringify({ type: 'error', message: 'ML-Position nicht gefunden.' })); 
      return;
    }

    const pos  = rows[0];
    const fade = pos.fade_time_sec || 1.0;

    const targetPan  = clamp(pos.pan_norm,  0, 1);
    const targetTilt = clamp(pos.tilt_norm, 0, 1);
    const targetZoom = clamp(pos.zoom_norm, 0, 1);

    mlPositionFade = null;
    mlState.pan    = targetPan;
    mlState.tilt   = targetTilt;
    mlState.zoom   = targetZoom;

    const reply = {
      type: 'ml_position_recalled',
      button_index,
      ml_state: {
        pan:    mlState.pan,
        tilt:   mlState.tilt,
        zoom:   mlState.zoom,
        dimmer: mlState.dimmer
      }
    };
    ws.send(JSON.stringify(reply));

    console.log(
      `[ML] (Legacy) Position Button ${button_index} recall – ` +
      `pan=${targetPan.toFixed(3)}, tilt=${targetTilt.toFixed(3)}, zoom=${targetZoom.toFixed(3)}, fade=${fade}s`
    );
  } catch (err) {
    console.error('[ML] Fehler beim Recall der Position (Legacy):', err);
    ws.send(JSON.stringify({ type: 'error', message: 'ML-Position konnte nicht geladen werden.' }));
  } finally {
    conn.release();
  }
}

/* --------------------------------------------------------
 * Initialzustand an Client schicken
 * ------------------------------------------------------*/

function sendInitState(ws) {
  const presetsArray = [];
  for (const [id, p] of presets) {
    presetsArray.push({
      id,
      name: p.meta.name,
      page: p.meta.page,
      fader_index: p.meta.fader_index,
      level: presetFaderLevels.get(id) ?? 0
    });
  }

  const channelsArray = dmxChannels.map(ch => ({
    id: ch.id,
    name: ch.name || `Ch ${ch.id}`,
    universe: ch.universe ?? ARTNET_UNIVERSE_DEFAULT,
    dmx_address: ch.dmx_address,
    channel_group: ch.channel_group ?? null,
    fixed_value: ch.fixed_value ?? null
  }));

  const msg = {
    type: 'init_state',
    presets: presetsArray,
    channels: channelsArray,
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
        user: DB_USER,
        password: DB_PASSWORD,
        database: DB_NAME,
        waitForConnections: true,
        connectionLimit: 10
      });

      await loadPatch();
      await loadPresets();
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
