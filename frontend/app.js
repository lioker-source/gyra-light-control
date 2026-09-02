/* Atrium Light – Tablet-Pult.
 *
 * Spricht ausschliesslich Protokoll v2 (siehe PROTOKOLL.md):
 *   Server -> Client : hello, patch, library, state, error, reloaded
 *   Client -> Server : ml.move/goto/zoom/dimmer, preset.fader/save/delete,
 *                      programmer.channel/clear, position.store/recall/update/delete,
 *                      master.grandmaster/blackout, settings.pad_sensitivity
 *
 * Grundregel aus PROTOKOLL.md §1: der Server haelt den Zustand, wir stellen
 * Antraege. Wir senden nur bei Aenderung; einzige fortlaufende Nachricht ist
 * ml.move waehrend einer Pad-Beruehrung (Totmann-Schalter im Server).
 */
'use strict';

const CFG = window.LIGHT_CFG || {};
const PROTOCOL = 2;

/* Nur waehrend einer Beruehrung, und hoechstens so oft: */
const MOVE_HZ        = 20;    // ml.move-Auffrischung (Server-Totmann: 400 ms)
const FADER_SEND_MS  = 50;    // Drossel fuer Fader-Aenderungen
const BUMP_FADE_MS   = 1000;  // Knopf unter dem Presetfader: Fahrt auf 0 % / 100 %
const POS_HOLD_MS    = 600;   // Halten = speichern
const HOLD_SLOP      = 12;    // Zittern, das ein Halten noch nicht abbricht (px)
const FADER_SLOP     = 6;     // Zittern, das den Faderwert noch nicht bewegt (px)
const DELETE_HOLD    = 800;   // Loeschen gegen Fehlgriff sichern
const PAD_DEADZONE   = 0.06;

/* Zwei-Finger-Geste. Zoom und Dimmer liegen auf derselben Beruehrung und
 * wurden vorher beide gleichzeitig bedient. Deshalb eine Sperre: sobald eine
 * der beiden Bewegungen GESTURE_LOCK_PX ueberschreitet, gewinnt die groessere
 * und die andere bleibt fuer die Dauer der Beruehrung stumm. */
const GESTURE_LOCK_PX  = 22;
const PINCH_ZOOM_PX    = 300;   // Fingerabstand fuer den vollen Zoomweg
const SWIPE_DIMMER_PX  = 170;   // Wischweg fuer den vollen Dimmerweg

/* ---------------------------------------------------------------------- */
/* Zustand                                                                 */
/* ---------------------------------------------------------------------- */

let ws = null;
let reconnectTries = 0;
let reconnectTimer = null;

let patch    = { channels: [], ml_fixtures: [] };
let library  = { presets: [], positions: [] };
let srv      = null;   // letzte state-Nachricht
let lastSeq  = -1;
let lastStateAt = null;
let helloAt = null;            // Zeitpunkt des Handshakes
let serverProtocol = null;
let statesSeit = [];           // Zeitstempel der letzten state-Nachrichten
let verworfeneStates = 0;      // zu alte/doppelte Pakete (PROTOKOLL.md §4.3)
let letzteDiag = null;         // letzte Antwort auf diag.request

const channelById = new Map();
let lockedChannelIds = new Set();     // gesperrt dargestellt
let positionChannelIds = new Set();   // Pan/Tilt: ueber die Positionsauswahl

/* Aufgebaute Bedienelemente, damit state-Updates nur Werte schreiben */
const presetFaders = new Map();     // preset_id -> Fader
const progFaders   = new Map();     // role -> { fader, channels } (Programmer)
let zoomFader = null, dimFader = null, sensFader = null, gmFader = null;

const $  = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const clamp   = (v, min, max) => Math.max(min, Math.min(max, v));

/* setPointerCapture wirft laut Spezifikation, wenn die Pointer-ID nicht mehr
 * aktiv ist - bei Mehrfingerbedienung durchaus moeglich. Ohne Absicherung
 * stirbt dann der ganze pointerdown-Handler und das Bedienelement bleibt
 * bis zum naechsten Antippen tot. Das Capture ist Komfort, kein Muss. */
function capture(node, ev) {
  try { node.setPointerCapture(ev.pointerId); } catch (e) { /* ohne geht es auch */ }
}
const pct = (v) => Math.round(v * 100) + '%';

/* ---------------------------------------------------------------------- */
/* Verbindung                                                              */
/* ---------------------------------------------------------------------- */

function wsUrl() {
  const params = new URLSearchParams(location.search);
  const override = params.get('ws');
  if (override) {
    // Der Override nennt Host und ggf. Port direkt. Schema passend zur Seite,
    // damit er auch hinter dem HTTPS-Proxy funktioniert.
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    return override.includes(':') ? `${proto}://${override}` : `${proto}://${override}:${CFG.port}`;
  }

  // Laeuft die Seite ueber HTTPS (Caddy-Proxy, siehe ops/caddy/), muss auch
  // der Socket verschluesselt sein - ein ws:// von einer https-Seite blockiert
  // der Browser als Mixed Content. Der Proxy reicht /ws an das Backend weiter,
  // deshalb ohne eigenen Port ueber denselben Ursprung.
  if (location.protocol === 'https:') {
    return `wss://${location.host}/ws`;
  }

  const host = CFG.host || location.hostname || '127.0.0.1';
  return `ws://${host}:${CFG.port}`;
}

function connect() {
  clearTimeout(reconnectTimer);
  // Die Adresse steht nicht mehr in der Kopfzeile, sondern im
  // Verbindungsfenster (Tippen auf die Anzeige).
  const url = wsUrl();
  let sock;
  try {
    sock = new WebSocket(url);
  } catch (e) {
    scheduleReconnect();
    return;
  }
  ws = sock;

  sock.addEventListener('open', () => {
    reconnectTries = 0;
    // "Verbunden" wird erst bei hello gesetzt - vorher ist die
    // Protokollversion nicht geprueft.
  });

  sock.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    handle(msg);
  });

  sock.addEventListener('close', () => {
    if (ws === sock) goOffline();
  });

  sock.addEventListener('error', () => { /* close folgt */ });
}

function scheduleReconnect() {
  reconnectTries++;
  $('#offline-try').textContent = `Neu verbinden … Versuch ${reconnectTries}`;
  const delay = Math.min(1000 * reconnectTries, 5000);
  reconnectTimer = setTimeout(connect, delay);
}

function goOffline() {
  document.body.classList.remove('online');
  document.body.classList.add('offline');
  if (lastStateAt) {
    $('#offline-time').textContent = lastStateAt.toLocaleTimeString('de-DE');
  }
  scheduleReconnect();
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

/* ---------------------------------------------------------------------- */
/* Eingehende Nachrichten                                                  */
/* ---------------------------------------------------------------------- */

function handle(msg) {
  switch (msg.type) {
    case 'hello':
      if (msg.protocol !== PROTOCOL) {
        // Passt die Version nicht, trennen wir selbst (PROTOKOLL.md §2).
        toast(`Protokoll ${msg.protocol} statt ${PROTOCOL} – bitte Seite neu laden.`, true);
        ws.close();
        return;
      }
      document.body.classList.add('online');
      document.body.classList.remove('offline');
      $('#conn-label').textContent = 'Verbunden';
      helloAt = new Date();
      serverProtocol = msg.protocol;
      break;

    case 'patch':
      patch = msg;
      indexPatch();
      buildProgrammer();
      buildPatchList();
      break;

    case 'library':
      library = msg;
      buildPresetBank();
      buildPositions();
      break;

    case 'state':
      // Aeltere Pakete verwerfen (PROTOKOLL.md §4.3).
      if (typeof msg.seq === 'number' && msg.seq <= lastSeq) { verworfeneStates++; return; }
      lastSeq = msg.seq;
      statesSeit.push(performance.now());
      if (statesSeit.length > 60) statesSeit.shift();
      srv = msg;
      lastStateAt = new Date();
      applyState(msg);
      break;

    case 'error':
      onServerError(msg);
      break;

    case 'reloaded':
      toast('Konfiguration neu geladen.');
      break;

    case 'diag':
      letzteDiag = msg;
      zeichneDiag();
      break;
  }
}

function onServerError(msg) {
  if (msg.code === 'slot_occupied' && msg.ref === 'preset.save') {
    // Der Server nennt den belegenden Datensatz mit - genau das braucht
    // der Rueckfrage-Dialog.
    askOverwrite(msg);
    return;
  }
  toast(msg.message || 'Fehler', true);
}

/* ---------------------------------------------------------------------- */
/* Patch auswerten                                                         */
/* ---------------------------------------------------------------------- */

function indexPatch() {
  channelById.clear();
  for (const ch of patch.channels) channelById.set(ch.id, ch);

  // Pan/Tilt/Zoom/Dimmer der Movinglights werden im Server nachgelagert
  // ueber die Szene geschrieben. Als normale Fader waeren sie wirkungslos,
  // deshalb im Programmer gesperrt statt versteckt.
  // Pan/Tilt bekommen keinen Fader: die Position wird aus den definierten
  // Slots gewaehlt, nicht in Kanalwerten getippt. Zoom und Dimmer sind
  // dagegen normale Kanaele - ein gesetzter Wert gewinnt gegen das Pad.
  positionChannelIds = new Set();
  for (const ml of patch.ml_fixtures || []) {
    for (const k of ['pan', 'pan_fine', 'tilt', 'tilt_fine']) {
      if (ml[k] != null) positionChannelIds.add(ml[k]);
    }
  }
  lockedChannelIds = new Set();
}

// Frueher wurden Kanaele mit fixed_value hier ausgeblendet. Seit der
// Startwert ueberschreibbar ist (Shutter, Farbtemperatur, Segmente),
// gehoeren sie in den Programmer.

/* ---------------------------------------------------------------------- */
/* Fader-Komponente (eine fuer alle vier Einsatzorte)                      */
/* ---------------------------------------------------------------------- */

function makeFader(opts) {
  const {
    name, value = 0, width = 72, height = null,
    tint = null, locked = false, sub = false, onChange = null, onHold = null,
    bump = false
  } = opts;

  const root = el('div', 'fader' + (locked ? ' locked' : ''));
  root.style.width  = width + 'px';
  // Ohne Hoehe bestimmt sie der Container (Presetbank: fuellt die Seite).
  if (height !== null) root.style.height = height + 'px';

  const nameEl = el('div', 'name', name);
  const track  = el('div', 'track');
  const rail   = el('div', 'rail');
  const fill   = el('div', 'fill');
  const grip   = el('div', 'grip');
  grip.appendChild(el('i'));
  const valEl  = el('div', 'val', pct(value));
  const subEl  = sub ? el('div', 'sub', '0') : null;

  // Knopf unter dem Fader: faehrt in BUMP_FADE_MS auf 100 %, wenn der Fader
  // auf 0 steht, sonst auf 0. Gesperrte Fader bekommen keinen.
  const bumpEl = (bump && !locked && onChange) ? el('div', 'bump') : null;

  if (tint) fill.style.background = tint;
  track.append(rail, fill, grip);
  root.append(nameEl, track, valEl);
  if (subEl) root.appendChild(subEl);
  if (bumpEl) root.appendChild(bumpEl);

  const api = {
    el: root, value, holding: false,
    setValue(v, force) {
      // Waehrend der Finger auf dem Fader liegt, nicht vom Server
      // ueberschreiben lassen - sonst springt der Griff unter dem Daumen weg.
      if (api.holding && !force) return;
      api.value = clamp01(v);
      paint();
    },
    setSub(text) { if (subEl) subEl.textContent = text; },
    setName(text) { nameEl.textContent = text; }
  };

  function paint() {
    const h = track.clientHeight;
    const y = Math.round(api.value * h);
    fill.style.height = y + 'px';
    grip.style.bottom = Math.max(-4, Math.min(h - 26, y - 15)) + 'px';
    valEl.textContent = pct(api.value);
    if (bumpEl) {
      // Die Beschriftung nennt das Ziel, nicht die Bedienung. Sie folgt auch
      // Aenderungen vom Server, deshalb steht sie hier und nicht im Klick.
      const hoch = api.value <= 0.001;
      bumpEl.textContent = hoch ? '▲ Voll' : '▼ Aus';
    }
  }

  /* Fahrt des Knopfes. Waehrend sie laeuft, gilt der eigene Wert: sonst
   * schreibt der Zustand vom Server (10 Hz) den aelteren Stand zurueck und
   * der Griff zappelt - dieselbe Sperre wie beim Finger auf dem Fader. */
  let fadeRaf = null;

  function fadeStoppen() {
    if (fadeRaf === null) return;
    cancelAnimationFrame(fadeRaf);
    fadeRaf = null;
    api.holding = false;
    root.classList.remove('faehrt');
    paint();
  }

  function fadeStarten() {
    const von  = api.value;
    const ziel = von > 0.001 ? 0 : 1;
    const start = performance.now();
    let gesendet = 0;

    api.holding = true;
    root.classList.add('faehrt');

    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / BUMP_FADE_MS);
      api.value = von + (ziel - von) * p;
      paint();

      const jetzt = performance.now();
      if (p >= 1 || jetzt - gesendet >= FADER_SEND_MS) {
        gesendet = jetzt;
        onChange(api.value);
      }
      if (p < 1) {
        fadeRaf = requestAnimationFrame(tick);
      } else {
        fadeRaf = null;
        api.holding = false;
        root.classList.remove('faehrt');
        paint();
      }
    };
    fadeRaf = requestAnimationFrame(tick);
  }

  if (bumpEl) {
    bumpEl.addEventListener('pointerdown', (ev) => {
      // Nicht zugleich den Fader selbst anfassen - der liegt darunter und
      // haette sonst seinen Halte-Timer fuer den Preset-Dialog gestartet.
      ev.stopPropagation();
      // Ein zweiter Druck waehrend der Fahrt haelt sie an, wie ein Griff an
      // einen laufenden Fader.
      if (fadeRaf !== null) fadeStoppen();
      else fadeStarten();
    });
  }

  if (!locked) {
    let lastSent = 0, holdTimer = null, moved = false;
    let nameGriff = false, startX = 0, startY = 0, startWert = 0;

    root.addEventListener('pointerdown', (ev) => {
      // Der Knopf unter dem Fader bedient sich selbst.
      if (bumpEl && bumpEl.contains(ev.target)) return;

      startX = ev.clientX;
      startY = ev.clientY;
      startWert = api.value;

      // Ueber dem Namen wird umbenannt, nicht gestellt.
      if (onHold && ev.target === nameEl) {
        capture(root, ev);
        nameGriff = true;
        fadeStoppen();
        holdTimer = setTimeout(() => { if (nameGriff) onHold(); }, POS_HOLD_MS);
        return;
      }

      capture(root, ev);
      fadeStoppen();          // Griff gewinnt gegen eine laufende Fahrt
      api.holding = true;
      moved = false;
      root.classList.add('holding');
    });

    root.addEventListener('pointermove', (ev) => {
      if (nameGriff) {
        // Ein Finger liegt nie ganz still. Erst ab HOLD_SLOP gilt das als
        // Wandern und bricht das Halten ab.
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) > HOLD_SLOP) {
          clearTimeout(holdTimer);
          nameGriff = false;
        }
        return;
      }
      if (!api.holding) return;

      /* Der Wert folgt der Fingerbewegung, nicht der Fingerposition.
       *
       * Vorher wurde er aus dem Abstand zur Bahnoberkante gerechnet. Das hat
       * zwei Fehler zugleich erzeugt: ein Druck ausserhalb der Bahn ergab
       * Werte ueber 1 bzw. unter 0 und liess den Fader springen, und um das
       * zu verhindern, musste die Bedienung auf die Bahn eingeschraenkt
       * werden - womit jeder Griff in Rand, Abstand oder Zahlenzeile
       * wirkungslos blieb. Relativ gerechnet faellt beides weg: die ganze
       * Kachel ist wieder anfassbar, und ein Antippen aendert nichts.
       *
       * getBoundingClientRect statt clientHeight, weil clientY in
       * Bildschirmpixeln zaehlt und die Buehne skaliert ist. */
      let dy = startY - ev.clientY;
      if (!moved) {
        if (Math.abs(dy) < FADER_SLOP) return;
        // Ab hier zaehlt die Bewegung - und zwar von hier aus. Ohne diesen
        // Nullpunkt spraenge der Wert beim Losfahren um die Schwelle.
        moved = true;
        clearTimeout(holdTimer);
        // Schwelle einmalig abziehen, statt den Nullpunkt zu versetzen: so
        // springt der Wert beim Losfahren nicht, und eine Bewegung, die die
        // Schwelle in einem Schritt ueberspringt, geht nicht verloren.
        startY += dy > 0 ? -FADER_SLOP : FADER_SLOP;
        dy = startY - ev.clientY;
      }

      const hoehe = track.getBoundingClientRect().height || 1;
      api.value = clamp01(startWert + dy / hoehe);
      paint();
      const now = performance.now();
      if (onChange && now - lastSent >= FADER_SEND_MS) {
        lastSent = now;
        onChange(api.value);
      }
    });

    const end = () => {
      clearTimeout(holdTimer);
      nameGriff = false;
      if (!api.holding) return;
      api.holding = false;
      root.classList.remove('holding');
      if (moved && onChange) onChange(api.value);   // Endwert sicher senden
    };
    root.addEventListener('pointerup', end);
    root.addEventListener('pointercancel', end);
  }

  requestAnimationFrame(paint);
  return api;
}

/* Liegender Fader fuer den Grandmaster. */
function makeHFader(node, onChange) {
  const fill = node.querySelector('.fill');
  const mark = node.querySelector('.mark');
  const grip = node.querySelector('.grip');
  let holding = false, lastSent = 0;

  const api = {
    value: 1, holding: false,
    setValue(v) {
      if (api.holding) return;
      api.value = clamp01(v);
      paint();
    }
  };
  function paint() {
    const p = api.value * 100;
    fill.style.width = p + '%';
    mark.style.left  = p + '%';
    grip.style.left  = p + '%';
    $('#gm-val').textContent = pct(api.value);
  }
  const val = (ev) => {
    const r = node.getBoundingClientRect();
    return clamp01((ev.clientX - r.left) / r.width);
  };
  node.addEventListener('pointerdown', (ev) => {
    capture(node, ev);
    api.holding = holding = true;
    api.value = val(ev); paint(); onChange(api.value);
  });
  node.addEventListener('pointermove', (ev) => {
    if (!holding) return;
    api.value = val(ev); paint();
    const now = performance.now();
    if (now - lastSent >= FADER_SEND_MS) { lastSent = now; onChange(api.value); }
  });
  const end = () => { if (!holding) return; holding = api.holding = false; onChange(api.value); };
  node.addEventListener('pointerup', end);
  node.addEventListener('pointercancel', end);
  paint();
  return api;
}

/* ---------------------------------------------------------------------- */
/* Live: Pad                                                               */
/* ---------------------------------------------------------------------- */

function setupPad() {
  const pad = $('#pad');
  const dot = $('#pad-dot');

  let touchId = null, originX = 0, originY = 0;
  let vx = 0, vy = 0, moveTimer = null;
  let pinch = null;   // {dist, zoom, midY, dimmer}

  const active = new Map();

  function startMoveLoop() {
    if (moveTimer) return;
    moveTimer = setInterval(() => {
      // Ohne Feld: es gilt die eingestellte Pad-Empfindlichkeit.
      send({ type: 'ml.move', pan_speed: vx, tilt_speed: vy });
    }, 1000 / MOVE_HZ);
  }
  function stopMoveLoop() {
    clearInterval(moveTimer);
    moveTimer = null;
    vx = vy = 0;
    // Genau einmal Stillstand melden (PROTOKOLL.md §3.2).
    send({ type: 'ml.move', pan_speed: 0, tilt_speed: 0 });
  }

  pad.addEventListener('pointerdown', (ev) => {
    capture(pad, ev);
    active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (active.size === 1) {
      touchId = ev.pointerId;
      originX = ev.clientX; originY = ev.clientY;
      startMoveLoop();
    } else if (active.size === 2) {
      // Zweiter Finger: Joystick abbrechen, Pinch/Wisch uebernimmt.
      stopMoveLoop();
      const pts = [...active.values()];
      pinch = {
        dist: Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y),
        midY: (pts[0].y + pts[1].y) / 2,
        zoom: zoomFader ? zoomFader.value : 0.5,
        dimmer: dimFader ? dimFader.value : 0,
        mode: null                       // 'zoom' | 'dimmer', siehe Gestensperre
      };
    }
  });

  let lastPinchSent = 0;

  pad.addEventListener('pointermove', (ev) => {
    if (!active.has(ev.pointerId)) return;
    active.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });

    if (active.size === 1 && ev.pointerId === touchId) {
      const r = pad.getBoundingClientRect();
      // Auslenkung ab dem Aufsetzpunkt -> Geschwindigkeit.
      let dx = (ev.clientX - originX) / (r.width / 2);
      let dy = (originY - ev.clientY) / (r.height / 2);
      dx = Math.max(-1, Math.min(1, dx));
      dy = Math.max(-1, Math.min(1, dy));
      vx = Math.abs(dx) < PAD_DEADZONE ? 0 : dx;
      vy = Math.abs(dy) < PAD_DEADZONE ? 0 : dy;
    } else if (active.size === 2 && pinch) {
      const pts = [...active.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const midY = (pts[0].y + pts[1].y) / 2;
      const dDist = dist - pinch.dist;
      const dMid  = pinch.midY - midY;

      // Gestensperre: die erste eindeutige Bewegung entscheidet, was gemeint
      // war. Danach bleibt die andere Achse bis zum Loslassen unberuehrt.
      if (!pinch.mode && Math.max(Math.abs(dDist), Math.abs(dMid)) >= GESTURE_LOCK_PX) {
        pinch.mode  = Math.abs(dDist) > Math.abs(dMid) ? 'zoom' : 'dimmer';
        pinch.fader = pinch.mode === 'zoom' ? zoomFader : dimFader;
        // Fuer die Dauer der Geste gehoert der Fader dem Finger. Ohne das
        // schreibt der state-Broadcast 10-mal pro Sekunde den aelteren
        // Serverwert darueber und der Griff springt hin und her - beim
        // Dimmer besonders stark, weil der Server ihn zusaetzlich glaettet.
        if (pinch.fader) pinch.fader.holding = true;
      }
      if (!pinch.mode || !pinch.fader) return;

      pinch.value = pinch.mode === 'zoom'
        // Invertiert: Finger zusammen = weiter, auseinander = enger.
        ? clamp01(pinch.zoom - dDist / PINCH_ZOOM_PX)
        : clamp01(pinch.dimmer + dMid / SWIPE_DIMMER_PX);

      // Anzeige bei jeder Bewegung, damit sie dem Finger folgt ...
      pinch.fader.setValue(pinch.value, true);

      // ... gesendet wird gedrosselt.
      const now = performance.now();
      if (now - lastPinchSent < FADER_SEND_MS) return;
      lastPinchSent = now;
      send({ type: pinch.mode === 'zoom' ? 'ml.zoom' : 'ml.dimmer', value: pinch.value });
    }
  });

  // Geste sauber abschliessen: Endwert genau einmal senden, damit der Server
  // nicht auf einem gedrosselten Zwischenwert stehen bleibt, und den Fader
  // wieder dem Zustand vom Server ueberlassen.
  function endPinch() {
    if (!pinch) return;
    if (pinch.fader) {
      pinch.fader.holding = false;
      if (pinch.value != null) {
        send({ type: pinch.mode === 'zoom' ? 'ml.zoom' : 'ml.dimmer', value: pinch.value });
      }
    }
    pinch = null;
  }

  const lift = (ev) => {
    if (!active.has(ev.pointerId)) return;
    active.delete(ev.pointerId);
    if (active.size < 2) endPinch();
    if (active.size === 0 && moveTimer) stopMoveLoop();
  };
  pad.addEventListener('pointerup', lift);
  pad.addEventListener('pointercancel', lift);

  return {
    setPosition(pan, tilt) {
      dot.style.left = (pan * 100) + '%';
      dot.style.top  = ((1 - tilt) * 100) + '%';
    }
  };
}

/* ---------------------------------------------------------------------- */
/* Live: Presetbank und Positionen                                         */
/* ---------------------------------------------------------------------- */

const PRESET_SLOTS = 16;   // feste Bank, keine Seiten
const PRESET_PAGE  = 1;

function presetAt(index) {
  return library.presets.find(p => p.page === PRESET_PAGE && p.fader_index === index) || null;
}

function buildPresetBank() {
  const bank = $('#presetbank');
  bank.textContent = '';
  presetFaders.clear();

  // Bearbeitetes Preset geloescht (hier oder von einem anderen Client)?
  // Dann darf der Programmer nicht weiter anbieten, dorthin zu speichern.
  if (editingPreset && !library.presets.some(p => p.id === editingPreset.id)) {
    setEditing(null);
  } else if (editingPreset) {
    // Umbenennung mitnehmen, damit die Knopfbeschriftung stimmt.
    const cur = library.presets.find(p => p.id === editingPreset.id);
    if (cur && cur.name !== editingPreset.name) setEditing(cur);
  }

  for (let i = 1; i <= PRESET_SLOTS; i++) {
    const p = presetAt(i);
    if (!p) {
      // Leerer Platz: langes Antippen fuehrt in den Programmer, wo der
      // Nutzer den Look baut. Der Platz bleibt als Ziel vorgemerkt.
      const box = el('div', 'fader-empty');
      box.appendChild(el('span', null, `Fader ${i}`));
      box.addEventListener('pointerdown', holdFor(box, () => openProgrammerFor(i)));
      bank.appendChild(box);
      continue;
    }
    const f = makeFader({
      name: p.name,
      bump: true,
      value: (srv && srv.preset_levels && srv.preset_levels[p.id]) || 0,
      onChange: (v) => send({ type: 'preset.fader', preset_id: p.id, level: v }),
      onHold: () => openPresetDialog(p)
    });
    presetFaders.set(p.id, f);
    bank.appendChild(f.el);
    f.setValue(f.value, true);
  }
}

/* Zerstoerender Knopf: loest erst nach Halten aus, mit sichtbarem Balken.
 *
 * Alles andere im Pult reagiert bewusst auf pointerdown - bei Fadern und
 * Pad zaehlt jede Millisekunde. Fuer Loeschen ist das aber falsch: die
 * Aktion liefe los, sobald der Finger aufsetzt, und liesse sich nicht mehr
 * abbrechen. Dieselbe Sicherung benutzt der Blackout-Knopf. */
function loeschKnopf(fn, ms = DELETE_HOLD) {
  const beschriftung = 'Löschen · halten';
  const b = el('div', 'btn danger halten');
  const label = el('span', null, beschriftung);
  const bar = el('i');
  b.append(label, bar);

  let timer = null, raf = null, start = 0;
  const abbrechen = () => {
    clearTimeout(timer); cancelAnimationFrame(raf);
    bar.style.width = '0';
  };

  b.addEventListener('pointerdown', (ev) => {
    capture(b, ev);
    start = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / ms);
      bar.style.width = (p * 100) + '%';
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    timer = setTimeout(() => { abbrechen(); fn(); }, ms);
  });
  b.addEventListener('pointerup', abbrechen);
  b.addEventListener('pointercancel', abbrechen);
  b.addEventListener('pointerleave', abbrechen);
  return b;
}

// Langer Druck auf einem Element, das kein Fader ist.
function holdFor(node, fn) {
  return function () {
    const t = setTimeout(fn, POS_HOLD_MS);
    const cancel = () => {
      clearTimeout(t);
      node.removeEventListener('pointerup', cancel);
      node.removeEventListener('pointercancel', cancel);
    };
    node.addEventListener('pointerup', cancel);
    node.addEventListener('pointercancel', cancel);
  };
}

/* Platz, der beim naechsten Speichern vorgeschlagen wird. Gesetzt vom
 * langen Druck auf einen leeren Fader, damit der Weg
 * "leerer Platz -> Programmer -> speichern" ohne Umweg zusammenfindet. */
let pendingSlot = null;

/* Preset, das gerade im Programmer bearbeitet wird. Solange es gesetzt ist,
 * bietet der Programmer das Zurueckspeichern in genau dieses Preset an,
 * statt nach einem Platz zu fragen. */
let editingPreset = null;

function setEditing(p) {
  editingPreset = p ? { id: p.id, name: p.name, fader_index: p.fader_index } : null;
  pendingSlot = p ? p.fader_index : pendingSlot;
  updateSaveButton();
}

function updateSaveButton() {
  const btn = $('#prog-save');
  if (!btn) return;
  btn.textContent = editingPreset
    ? `„${editingPreset.name}“ aktualisieren`
    : 'Als Preset speichern …';
}

function showPage(name) {
  // Die Lampenauswahl im Programmer bleibt beim Seitenwechsel bestehen -
  // ein Look entsteht ueber mehrere Gruppen hinweg.
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.page === name));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('active', p.id === 'page-' + name));
}

function openProgrammerFor(index) {
  pendingSlot = index;
  showPage('programmer');
  toast(`Platz ${index}: einstellen, dann „Als Preset speichern“.`);
}

function buildPositions() {
  const grid = $('#positions');
  grid.textContent = '';

  for (const p of library.positions) {
    const box = el('div', 'pos' + (p.occupied ? '' : ' free'));

    if (p.occupied) {
      const top = el('div', 'top');
      const links = el('div', 'slot', String(p.slot));
      if (p.used_by && p.used_by.length) {
        // Zeigt, dass mindestens ein Preset auf diesen Slot verweist.
        const mark = el('span', 'ref', ' ★');
        mark.title = p.used_by.map(u => u.name).join(', ');
        links.appendChild(mark);
      }
      top.append(links, el('div', 'fade', Number(p.fade_time_sec).toFixed(1) + ' s'));
      const mid = el('div', 'mid');
      mid.appendChild(el('div', 'nm', p.name || `Pos ${p.slot}`));
      const edit = el('div', 'edit', '…');
      edit.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); openPositionDialog(p); });
      box.append(top, mid, edit);
    } else {
      box.append(el('div', 'slot', String(p.slot)),
                 el('div', 'hint', 'leer · halten zum Speichern'));
    }

    // Kurz tippen = anfahren, halten = speichern (PROTOKOLL.md §3.5).
    let holdTimer = null, held = false;
    box.addEventListener('pointerdown', () => {
      held = false;
      box.classList.add('held');
      holdTimer = setTimeout(() => {
        held = true;
        send({ type: 'position.store', slot: p.slot,
               name: p.name || `Pos ${p.slot}`,
               fade_time_sec: p.occupied ? Number(p.fade_time_sec) : 2.0 });
        toast(`Position ${p.slot} gespeichert.`);
      }, POS_HOLD_MS);
    });
    const up = () => {
      clearTimeout(holdTimer);
      box.classList.remove('held');
      if (!held && p.occupied) send({ type: 'position.recall', slot: p.slot });
    };
    box.addEventListener('pointerup', up);
    box.addEventListener('pointercancel', () => { clearTimeout(holdTimer); box.classList.remove('held'); });

    grid.appendChild(box);
  }
}

/* ---------------------------------------------------------------------- */
/* Programmer                                                              */
/* ---------------------------------------------------------------------- */

/* Kurzbezeichnung je Rolle. Der Fixture-Name steht in der Kartenkopfzeile,
 * im Fader genuegt die Funktion - "Rot" statt "RGB 16 1 Rot". */
const ROLE_LABEL = {
  dimmer: 'Dimmer', shutter: 'Shutter',
  r: 'Rot', g: 'Grün', b: 'Blau', a: 'Amber', w: 'Weiß',
  pan: 'Pan', pan_fine: 'Pan fein', tilt: 'Tilt', tilt_fine: 'Tilt fein',
  pt_speed: 'P/T Speed', zoom: 'Zoom', strobe: 'Stroboskop',
  cw1: 'Kaltweiß 1', ww1: 'Warmweiß 1', cw2: 'Kaltweiß 2', ww2: 'Warmweiß 2',
  cw3: 'Kaltweiß 3', ww3: 'Warmweiß 3', ctc: 'Farb\u00ADtemperatur',
  seg_pattern: 'Segment-Muster', seg_fade: 'Muster-Übergang',
  zoom_auto: 'Zoom-Automatik', pt_auto: 'P/T-Automatik'
};

/* Reihenfolge der Attribut-Fader. Nach DMX-Adresse zu sortieren gibt bei
 * gemischter Auswahl eine willkuerliche Folge (Weiss vor Amber, weil die
 * erste Lampe kein Amber hat). Diese Liste haelt sie stattdessen stabil;
 * was hier fehlt, haengt sich nach Adresse hinten an. */
const ROLE_ORDER = [
  'dimmer', 'shutter', 'strobe',
  'r', 'g', 'b', 'a', 'w',
  'cw1', 'ww1', 'cw2', 'ww2', 'cw3', 'ww3', 'ctc',
  'zoom', 'pt_speed', 'seg_pattern', 'seg_fade', 'zoom_auto', 'pt_auto'
];

const ROLE_TINT = {
  r: 'var(--red)', g: 'var(--green)', b: 'var(--blue)',
  a: '#D98A2B', w: '#D9D2C4'
};

const TYPE_LABEL = {
  dimmer: 'Dimmer', dimmer_shutter: 'Dimmer + Shutter',
  rgbw: 'LED RGBW', rgbaw: 'LED RGBAW', moving_head: 'Moving Light'
};

/* Auswahl der Lampen. Der Programmer arbeitet wie ein Pult: erst markieren,
 * dann die gemeinsamen Attribute setzen, dann die naechste Gruppe. Die
 * Auswahl ist reine Bedienoberflaeche und bleibt im Geraet - der Server
 * kennt nur einzelne Kanalwerte (PROTOKOLL.md §3.4). */
const selectedFixtures = new Set();
const aktivMarker = new Map();   // fixture_id -> Anzeige belegter Kanaele

/* Nach programmer.load_preset die Lampen markieren, die Werte tragen -
 * sonst steht man vor einem gefuellten Programmer ohne sichtbare Fader. */
let autoSelectOnNextState = false;

function buildProgrammer() {
  buildFixturePicker();
  buildAttributes();
  updateProgrammerCount();
}

/* ---- Auswahl ---------------------------------------------------------- */

function buildFixturePicker() {
  const grid = $('#prog-fixtures');
  grid.textContent = '';
  aktivMarker.clear();

  for (const f of patch.fixtures || []) {
    const channels = patch.channels.filter(c => c.fixture_id === f.id);
    if (!channels.length) continue;

    const tile = el('div', 'fx' + (selectedFixtures.has(f.id) ? ' sel' : ''));
    tile.append(el('div', 'nm', f.name),
                el('div', 'r', `${TYPE_LABEL[f.type] || f.type} · ${addressRange(channels)}`));
    const aktiv = el('div', 'belegt');
    aktivMarker.set(f.id, { el: aktiv, channels: channels.map(c => c.id) });
    tile.appendChild(aktiv);

    tile.addEventListener('pointerdown', () => {
      if (selectedFixtures.has(f.id)) selectedFixtures.delete(f.id);
      else selectedFixtures.add(f.id);
      buildProgrammer();
      if (srv) applyState(srv);
    });

    grid.appendChild(tile);
  }
}

function selectAllFixtures(an) {
  selectedFixtures.clear();
  if (an) for (const f of patch.fixtures || []) selectedFixtures.add(f.id);
  buildProgrammer();
  if (srv) applyState(srv);
}

/* ---- Attribute der Auswahl -------------------------------------------- */

/* Alle Rollen der markierten Lampen, in der Reihenfolge der DMX-Adressen.
 * Bewusst die Vereinigung, nicht die Schnittmenge: wer Dimmer und LED
 * zusammen markiert, will den Dimmer trotzdem stellen koennen. Ein Fader
 * wirkt nur auf die Lampen, die diese Rolle ueberhaupt haben. */
function rolesOfSelection() {
  const rollen = new Map();   // role -> channel-ids
  const kanaele = patch.channels
    .filter(c => selectedFixtures.has(c.fixture_id))
    .filter(c => !positionChannelIds.has(c.id))   // steckt in der Positionsauswahl
    .sort((a, b) => a.dmx_address - b.dmx_address);

  for (const c of kanaele) {
    if (!rollen.has(c.role)) rollen.set(c.role, []);
    rollen.get(c.role).push(c.id);
  }

  const rang = (role) => {
    const i = ROLE_ORDER.indexOf(role);
    return i === -1 ? ROLE_ORDER.length : i;
  };
  return new Map([...rollen.entries()].sort((a, b) => rang(a[0]) - rang(b[0])));
}

function buildAttributes() {
  const body = $('#prog-attr-body');
  body.textContent = '';
  progFaders.clear();

  const anzahl = selectedFixtures.size;
  const sub = $('#prog-attr-sub');

  if (!anzahl) {
    sub.textContent = 'keine Auswahl';
    body.appendChild(el('div', 'leer-hinweis',
      'Oben Lampen antippen. Die gemeinsamen Attribute erscheinen dann hier.'));
    return;
  }

  const rollen = rolesOfSelection();
  sub.textContent = `${anzahl} ${anzahl === 1 ? 'Lampe' : 'Lampen'} · `
                  + `${rollen.size} ${rollen.size === 1 ? 'Attribut' : 'Attribute'}`;

  // Die Position kommt aus den definierten Slots, nicht aus Kanalwerten -
  // deshalb eine eigene Zeile, sobald ein Moving Light markiert ist.
  const hatML = (patch.fixtures || [])
    .some(f => selectedFixtures.has(f.id) && f.type === 'moving_head');
  if (hatML) body.appendChild(positionPicker());

  const streifen = el('div', 'attr-faders');

  for (const [role, ids] of rollen) {
    const locked = ids.every(id => lockedChannelIds.has(id));
    const fader = makeFader({
      // Keine feste Hoehe: der Streifen teilt die Flaeche auf seine Reihen
      // auf. Bei 196 px fest wurde die zweite Reihe angeschnitten, sobald
      // eine Auswahl mehr als rund 15 Attribute hatte.
      name: ROLE_LABEL[role] || role,
      value: 0, width: 76,
      tint: ROLE_TINT[role] || null,
      locked, sub: true,
      onChange: (v) => {
        // Ein Griff, viele Kanaele: der Server kennt nur Einzelkanaele.
        for (const id of ids) send({ type: 'programmer.channel', channel_id: id, value: v });
        fader.setSub(String(Math.round(v * 255)));
      }
    });
    if (ids.length > 1) fader.el.classList.add('gruppe');
    fader.setSub('0');
    progFaders.set(role, { fader, channels: ids });
    streifen.appendChild(fader.el);
    fader.setValue(fader.value, true);
  }

  body.appendChild(streifen);
}

/* Positionsauswahl im Programmer. Ein Preset speichert den Slot als
 * Verweis, nicht als Pan/Tilt-Werte - damit bleibt die Position in der Hand
 * von Pad und Positionsliste und kann sich nicht mit ihr streiten. */
function positionPicker() {
  const wrap = el('div', 'pospick');
  wrap.appendChild(el('div', 'cap', 'POSITION'));
  const row = el('div', 'wahl');

  const aktuell = srv ? srv.programmer_position : null;

  const keine = el('div', 'p' + (aktuell == null ? ' sel' : ''), 'keine');
  keine.addEventListener('pointerdown', () => send({ type: 'programmer.position', slot: null }));
  row.appendChild(keine);

  for (const p of library.positions) {
    if (!p.occupied) continue;
    const b = el('div', 'p' + (aktuell === p.slot ? ' sel' : ''));
    b.append(el('div', 'n', String(p.slot)), el('div', 'nm', p.name || `Pos ${p.slot}`));
    b.addEventListener('pointerdown', () => send({ type: 'programmer.position', slot: p.slot }));
    row.appendChild(b);
  }

  wrap.appendChild(row);
  return wrap;
}

function addressRange(channels) {
  const von = Math.min(...channels.map(c => c.dmx_address));
  const bis = Math.max(...channels.map(c => c.dmx_address));
  return von === bis ? String(von) : `${von}–${bis}`;
}

function updateProgrammerCount() {
  const n = srv && srv.programmer ? Object.keys(srv.programmer).length : 0;
  $('#prog-count').textContent = `${n} ${n === 1 ? 'Kanal' : 'Kanäle'} im Programmer`;
}

/* ---------------------------------------------------------------------- */
/* state anwenden                                                          */
/* ---------------------------------------------------------------------- */

let pad = null;
let lastProgrammerPosition;

function applyState(s) {
  if (pad) pad.setPosition(s.ml.pan, s.ml.tilt);
  $('#pad-fade').classList.toggle('on', !!s.ml.fading);

  if (zoomFader) zoomFader.setValue(s.ml.zoom);
  if (dimFader)  dimFader.setValue(s.ml.dimmer);
  // Der Controller fuehrt Dimmer und Zoom waehrend der Bedienung selbst.
  // Ausserhalb davon uebernimmt er den Serverwert, damit die naechste
  // Taste dort weitermacht, wo das Licht wirklich steht.
  if (!gp.dim.fuehrt)  gp.dim.wert  = s.ml.dimmer;
  if (!gp.zoom.fuehrt) gp.zoom.wert = s.ml.zoom;
  if (sensFader) sensFader.setValue(s.pad_sensitivity);
  if (gmFader)   gmFader.setValue(s.master.grandmaster);

  document.body.classList.toggle('blackout', !!s.master.blackout);
  blackoutSetzen();

  for (const [id, f] of presetFaders) {
    f.setValue((s.preset_levels && s.preset_levels[id]) || 0);
  }
  for (const [, eintrag] of progFaders) {
    const { fader, channels } = eintrag;
    const werte = channels.map(id => (s.programmer && s.programmer[id]) || 0);
    const ersterWert = werte[0];
    // Stehen die Lampen der Auswahl unterschiedlich, gibt es keinen einen
    // Wert. Der Griff zeigt dann den ersten; die Beschriftung sagt, dass
    // gemischt wird. Sobald man den Fader anfasst, ziehen alle gleich.
    const gemischt = werte.some(v => Math.abs(v - ersterWert) > 0.002);
    fader.setValue(ersterWert);
    if (!fader.holding) fader.setSub(gemischt ? 'gem.' : String(Math.round(ersterWert * 255)));
    fader.el.classList.toggle('gemischt', gemischt);
  }
  if (autoSelectOnNextState && s.programmer && Object.keys(s.programmer).length) {
    autoSelectOnNextState = false;
    selectedFixtures.clear();
    for (const id of Object.keys(s.programmer)) {
      if (!(s.programmer[id] > 0)) continue;
      const ch = channelById.get(Number(id));
      if (ch) selectedFixtures.add(ch.fixture_id);
    }
    buildProgrammer();
  }

  // Positionsauswahl folgt dem Server (auch von einem anderen Geraet).
  if (lastProgrammerPosition !== s.programmer_position) {
    lastProgrammerPosition = s.programmer_position;
    buildProgrammer();
  }

  for (const [, m] of aktivMarker) {
    const n = m.channels.filter(id => (s.programmer && s.programmer[id] > 0)).length;
    m.el.textContent = n ? `${n} belegt` : '';
    m.el.className = 'belegt' + (n ? ' an' : '');
  }

  updateProgrammerCount();
}

/* ---------------------------------------------------------------------- */
/* Dialoge                                                                 */
/* ---------------------------------------------------------------------- */

function openModal(node) {
  const m = $('#modal');
  m.textContent = '';
  m.appendChild(node);
  m.classList.add('on');
}
function closeModal() {
  diagOffen = false;
  $('#modal').classList.remove('on');
  $('#modal').textContent = '';
}

function dialog(title, text) {
  const d = el('div', 'dlg');
  const head = el('div');
  head.style.cssText = 'display:flex;flex-direction:column;gap:8px;';
  head.append(el('h2', null, title), el('p', null, text));
  d.appendChild(head);
  return d;
}

/* Belegter Platz: umbenennen, im Programmer bearbeiten, loeschen.
 * Bewusst ohne Rueckfragen - jede Aktion fuehrt direkt aus und schliesst. */
function openPresetDialog(p) {
  const d = dialog(`Preset ${p.fader_index}`, 'Umbenennen, im Programmer bearbeiten oder löschen.');

  const field = el('div', 'field');
  field.appendChild(el('div', 'cap', 'NAME'));
  const input = el('input');
  input.type = 'text';
  input.value = p.name || '';
  field.appendChild(input);

  // Zwei Reihen: der lange Knopf steht allein, damit nichts gequetscht wird.
  const rowEdit = el('div', 'row');
  const edit = el('div', 'btn wide', 'Im Programmer bearbeiten');
  edit.addEventListener('pointerdown', () => {
    // Der Server fuellt den Programmer; die Werte kommen ueber den
    // naechsten state-Broadcast zurueck.
    autoSelectOnNextState = true;
    send({ type: 'programmer.load_preset', preset_id: p.id });
    setEditing(p);
    closeModal();
    showPage('programmer');
    toast(`„${p.name}“ im Programmer geöffnet.`);
  });
  rowEdit.appendChild(edit);

  const row = el('div', 'row');

  const del = loeschKnopf(() => {
    send({ type: 'preset.delete', preset_id: p.id });
    closeModal();
  });

  const cancel = el('div', 'btn', 'Abbrechen');
  cancel.addEventListener('pointerdown', closeModal);

  const ok = el('div', 'btn primary', 'Umbenennen');
  ok.addEventListener('pointerdown', () => {
    const name = input.value.trim();
    // preset.update statt preset.save: save wuerde die gespeicherten
    // Kanalwerte durch den aktuellen Programmer ersetzen.
    if (name && name !== p.name) send({ type: 'preset.update', preset_id: p.id, name });
    closeModal();
  });

  row.append(del, cancel, ok);
  d.append(field, rowEdit, row);
  openModal(d);
}

/* Platz fuer ein neues Preset waehlen (aus dem Programmer). */
function askSlot(preselect, existing) {
  const d = dialog('Als Preset speichern',
    'Gespeichert wird, was gerade im Programmer steht. Ein belegter Platz wird mit dem gewählten Namen überschrieben.');

  let chosen = preselect;
  const grid = el('div'); grid.id = 'slotgrid';

  const field = el('div', 'field');
  field.appendChild(el('div', 'cap', 'NAME'));
  const input = el('input'); input.type = 'text';
  field.appendChild(input);

  const row = el('div', 'row');
  const cancel = el('div', 'btn', 'Abbrechen');
  cancel.addEventListener('pointerdown', closeModal);
  const ok = el('div', 'btn primary', 'Speichern');

  // Zuletzt selbst eingesetzter Name. Nur wenn das Feld unveraendert
  // danebensteht, darf ein Platzwechsel ihn ersetzen - sonst geht ein
  // von Hand getippter Name verloren.
  let autoName = null;

  function fillName() {
    const p = presetAt(chosen);
    const vorschlag = p ? p.name : (existing ? existing.name : 'Neues Preset');
    if (input.value === '' || input.value === autoName) {
      input.value = vorschlag;
      autoName = vorschlag;
    }
  }

  function paintButton() {
    // Beschriftung sagt, was passiert. Ein belegter Platz wird direkt
    // ersetzt: die Auswahl im Raster IST die Bestaetigung, und der Name
    // des Platzes steht dabei sichtbar im Feld.
    ok.textContent = presetAt(chosen) ? 'Überschreiben' : 'Speichern';
    ok.classList.toggle('danger', !!presetAt(chosen));
    ok.classList.toggle('primary', !presetAt(chosen));
  }

  const paint = () => {
    grid.textContent = '';
    for (let i = 1; i <= PRESET_SLOTS; i++) {
      const p = presetAt(i);
      const sl = el('div', 'slot' + (p ? ' taken' : '') + (i === chosen ? ' sel' : ''));
      sl.append(el('div', 'n', String(i)), el('div', 'nm', p ? p.name : 'frei'));
      sl.addEventListener('pointerdown', () => {
        chosen = i;
        fillName();
        paintButton();
        paint();
      });
      grid.appendChild(sl);
    }
  };
  fillName();
  paintButton();
  paint();

  ok.addEventListener('pointerdown', () => {
    const belegt = presetAt(chosen);
    // channels bewusst weglassen: der Server friert den Programmer ein
    // (PROTOKOLL.md §3.3 / Entscheidung §10.2) und leert ihn danach.
    // Mit preset_id ersetzt der Server den belegten Platz direkt, statt
    // mit slot_occupied zu antworten.
    send({ type: 'preset.save', preset_id: belegt ? belegt.id : null,
           name: input.value.trim() || 'Preset',
           page: PRESET_PAGE, fader_index: chosen });
    toast(belegt ? `Platz ${chosen} überschrieben.` : `Auf Platz ${chosen} gespeichert.`);
    pendingSlot = null;
    setEditing(null);
    closeModal();
    // Bewusst im Programmer bleiben: der naechste Look wird oft direkt
    // danach gebaut. Nur das Aktualisieren eines Presets springt auf Live.
  });
  row.append(cancel, ok);

  d.append(field, grid, row);
  openModal(d);
}

/* Antwort des Servers auf einen belegten Platz. */
function askOverwrite(errMsg) {
  const d = dialog('Platz ist belegt', errMsg.message || 'Dieser Platz ist bereits belegt.');

  const pid = errMsg.preset_id;
  const row = el('div', 'row');

  const cancel = el('div', 'btn', 'Abbrechen');
  cancel.addEventListener('pointerdown', closeModal);

  const del = loeschKnopf(() => {
    send({ type: 'preset.delete', preset_id: pid });
    closeModal();
  });

  const over = el('div', 'btn danger', 'Überschreiben');
  over.addEventListener('pointerdown', () => {
    const p = library.presets.find(x => x.id === pid);
    if (p) {
      send({ type: 'preset.save', preset_id: pid, name: p.name,
             page: p.page, fader_index: p.fader_index });
    }
    closeModal();
  });

  row.append(cancel, del, over);
  d.appendChild(row);
  openModal(d);
}

/* Positionsslot: nur Name und Fadezeit (position.update). */
function openPositionDialog(p) {
  const d = dialog(`Position ${p.slot}`,
    'Ändert nur Name und Fadezeit. Die gespeicherte Position bleibt unverändert – der Kopf bewegt sich nicht.');

  const field = el('div', 'field');
  field.appendChild(el('div', 'cap', 'NAME'));
  const input = el('input'); input.type = 'text'; input.value = p.name || '';
  field.appendChild(input);

  let fade = Number(p.fade_time_sec) || 0;
  const fadeField = el('div', 'field');
  fadeField.appendChild(el('div', 'cap', 'FADEZEIT'));
  const st = el('div', 'stepper');
  const minus = el('div', 'btn', '−');
  const out   = el('div', 'out');
  const outVal = el('b', null, fade.toFixed(1));
  out.append(outVal, el('span', null, 'Sekunden'));
  const plus  = el('div', 'btn', '+');
  const setFade = (v) => { fade = Math.max(0, Math.min(60, Math.round(v * 10) / 10)); outVal.textContent = fade.toFixed(1); };
  minus.addEventListener('pointerdown', () => setFade(fade - 0.5));
  plus.addEventListener('pointerdown',  () => setFade(fade + 0.5));
  st.append(minus, out, plus);
  fadeField.appendChild(st);

  const row = el('div', 'row');
  const del = loeschKnopf(() => { send({ type: 'position.delete', slot: p.slot }); closeModal(); });

  // Verweisende Presets benennen, bevor geloescht wird.
  if (p.used_by && p.used_by.length) {
    const namen = p.used_by.map(u => `„${u.name}“`).join(', ');
    const warn = el('div', 'box warn');
    warn.append(
      el('div', 'cap', 'WIRD VERWENDET'),
      el('div', 'main', `${p.used_by.length === 1 ? 'Ein Preset verweist' : p.used_by.length + ' Presets verweisen'} auf diese Position: ${namen}.`),
      el('div', 'list', 'Beim Löschen verlieren sie die Position und fahren den Kopf nicht mehr an. Die übrigen Werte bleiben erhalten.')
    );
    d.appendChild(warn);
  }
  const sp = el('div'); sp.style.flexGrow = '1';
  const cancel = el('div', 'btn', 'Abbrechen');
  cancel.addEventListener('pointerdown', closeModal);
  const ok = el('div', 'btn primary', 'Speichern');
  ok.addEventListener('pointerdown', () => {
    send({ type: 'position.update', slot: p.slot, name: input.value.trim() || p.name, fade_time_sec: fade });
    closeModal();
  });
  row.append(del, sp, cancel, ok);

  d.append(field, fadeField, el('div', 'hr'), row,
           el('div', 'foot', 'Position neu setzen: den Button auf dem Live-Screen lang drücken.'));
  openModal(d);
}

/* ---------------------------------------------------------------------- */
/* Patch-Editor                                                            */
/* ---------------------------------------------------------------------- */

function typeLabel(t) {
  const def = (patch.fixture_types || []).find(x => x.type === t);
  return def ? def.label : t;
}

/* Adressen, die von mehr als einem Fixture belegt werden. Wird angezeigt,
 * aber nicht verhindert - beim Umpatchen ist eine Ueberschneidung
 * zwischendurch normal. */
function addressConflicts() {
  const belegt = new Map();          // "universe:adresse" -> [Fixturenamen]
  for (const ch of patch.channels) {
    const key = `${ch.universe}:${ch.dmx_address}`;
    const f = (patch.fixtures || []).find(x => x.id === ch.fixture_id);
    if (!belegt.has(key)) belegt.set(key, new Set());
    belegt.get(key).add(f ? f.name : '?');
  }
  const betroffen = new Set();
  for (const namen of belegt.values()) {
    if (namen.size > 1) for (const n of namen) betroffen.add(n);
  }
  return betroffen;
}

function buildPatchList() {
  const list = $('#patch-list');
  if (!list) return;
  list.textContent = '';

  const konflikte = addressConflicts();
  const fixtures = [...(patch.fixtures || [])].sort((a, b) =>
    a.universe - b.universe || a.start_address - b.start_address);

  // Echte Tabelle: der Patch ist tabellarisch zu lesen - Adressen
  // untereinander, damit Luecken und Ueberschneidungen auffallen.
  const tab = el('table', 'ptab');
  const thead = el('thead');
  const kopf = el('tr');
  for (const [text, cls] of [['Adresse', 'adr'], ['Name', 'nm'], ['Bauart', 'ty'],
                             ['Kanäle', 'num'], ['Univ.', 'num'], ['', 'chev']]) {
    kopf.appendChild(el('th', cls, text));
  }
  thead.appendChild(kopf);

  const tbody = el('tbody');
  for (const f of fixtures) {
    const bis = f.start_address + (f.channel_count || 1) - 1;
    const tr = el('tr', konflikte.has(f.name) ? 'konflikt' : null);

    tr.appendChild(el('td', 'adr', f.start_address === bis
      ? String(f.start_address)
      : `${f.start_address}–${bis}`));
    tr.appendChild(el('td', 'nm', f.name));
    tr.appendChild(el('td', 'ty', typeLabel(f.type)));
    tr.appendChild(el('td', 'num', String(f.channel_count)));
    tr.appendChild(el('td', 'num', String(f.universe)));

    tr.appendChild(el('td', 'chev', '›'));

    // Die ganze Zeile oeffnet den Editor. Ein Knopf je Zeile waere mit
    // seinen 44 px so hoch, dass die Tabelle schon bei elf Fixtures
    // scrollt - die Zeile selbst ist das groessere Trefferziel.
    tr.addEventListener('pointerdown', () => openFixtureDialog(f));

    tbody.appendChild(tr);
  }

  tab.append(thead, tbody);
  list.appendChild(tab);

  $('#patch-count').textContent =
    `${fixtures.length} ${fixtures.length === 1 ? 'Fixture' : 'Fixtures'} · ${patch.channels.length} Kanäle`;
  $('#patch-warn').innerHTML = konflikte.size
    ? `<span style="color:var(--redTxt)">Adressüberschneidung: ${[...konflikte].join(', ')}</span>`
    : '&nbsp;';
}

/* Anlegen und Bearbeiten teilen sich den Dialog. `f` null = neu. */
function openFixtureDialog(f) {
  const neu = !f;
  const d = dialog(neu ? 'Fixture hinzufügen' : `Fixture ${f.name}`,
    neu ? 'Der Server legt die Kanäle nach der gewählten Bauart selbst an.'
        : 'Adresse, Name und Universe ändern lassen die Kanäle bestehen – Presets bleiben erhalten.');

  // Name
  const nf = el('div', 'field');
  nf.appendChild(el('div', 'cap', 'NAME'));
  const name = el('input'); name.type = 'text';
  name.value = neu ? '' : f.name;
  nf.appendChild(name);

  // Bauart
  let typ = neu ? (patch.fixture_types[0]?.type) : f.type;
  const tf = el('div', 'field');
  tf.appendChild(el('div', 'cap', 'BAUART'));
  const tg = el('div', 'typen');
  const paintTypes = () => {
    tg.textContent = '';
    for (const t of patch.fixture_types || []) {
      const b = el('div', 'ty' + (t.type === typ ? ' sel' : ''));
      b.append(el('div', 'l', t.label), el('div', 'n', `${t.channel_count} Kanäle`));
      b.addEventListener('pointerdown', () => { typ = t.type; paintTypes(); paintWarn(); });
      tg.appendChild(b);
    }
  };
  paintTypes();
  tf.appendChild(tg);

  // Startadresse
  const af = el('div', 'field');
  af.appendChild(el('div', 'cap', 'STARTADRESSE'));
  let adr = neu ? naechsteFreieAdresse() : f.start_address;
  const st = el('div', 'stepper');
  const minus = el('div', 'btn', '−');
  const out = el('div', 'out');
  const outV = el('b', null, String(adr));
  out.append(outV, el('span', null, 'bis –'));
  const plus = el('div', 'btn', '+');
  const setAdr = (v) => {
    adr = Math.max(1, Math.min(512, v));
    outV.textContent = String(adr);
    const anzahl = (patch.fixture_types.find(t => t.type === typ)?.channel_count) || 1;
    out.querySelector('span').textContent = `bis ${adr + anzahl - 1}`;
  };
  minus.addEventListener('pointerdown', () => setAdr(adr - 1));
  plus.addEventListener('pointerdown', () => setAdr(adr + 1));
  st.append(minus, out, plus);
  af.appendChild(st);
  setAdr(adr);

  // Warnung beim Bauartwechsel
  const warn = el('div', 'box warn');
  warn.style.display = 'none';
  warn.append(el('div', 'cap', 'BAUART WIRD GEWECHSELT'),
              el('div', 'main', 'Die Kanäle dieses Fixtures werden neu angelegt.'),
              el('div', 'list', 'Presetwerte, die auf die bisherigen Kanäle zeigen, gehen dabei verloren. Adresse oder Name allein zu ändern ist unkritisch.'));
  const paintWarn = () => {
    warn.style.display = (!neu && typ !== f.type) ? 'flex' : 'none';
    setAdr(adr);
  };
  paintWarn();

  // Knöpfe
  const row = el('div', 'row');
  if (!neu) {
    const del = loeschKnopf(() => {
      send({ type: 'patch.fixture.delete', id: f.id });
      toast(`${f.name} entfernt.`);
      closeModal();
    });
    row.appendChild(del);
  }
  const sp = el('div'); sp.style.flexGrow = '1';
  const cancel = el('div', 'btn', 'Abbrechen');
  cancel.addEventListener('pointerdown', closeModal);
  const ok = el('div', 'btn primary', neu ? 'Anlegen' : 'Übernehmen');
  ok.addEventListener('pointerdown', () => {
    const nm = name.value.trim() || typeLabel(typ);
    send(neu
      ? { type: 'patch.fixture.create', name: nm, fixture_type: typ, universe: 0, start_address: adr }
      : { type: 'patch.fixture.update', id: f.id, name: nm, fixture_type: typ, universe: f.universe, start_address: adr });
    closeModal();
  });
  row.append(sp, cancel, ok);

  d.append(nf, tf, af, warn, row);
  openModal(d);
}

/* Erste Adresse hinter dem letzten belegten Kanal. */
function naechsteFreieAdresse() {
  let max = 0;
  for (const ch of patch.channels) if (ch.dmx_address > max) max = ch.dmx_address;
  return Math.min(512, max + 1);
}

/* ---------------------------------------------------------------------- */
/* Kurzmeldung                                                             */
/* ---------------------------------------------------------------------- */

let toastTimer = null;
function toast(text, isError) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.toggle('err', !!isError);
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

/* ---------------------------------------------------------------------- */
/* Aufbau                                                                  */
/* ---------------------------------------------------------------------- */

function setupHeader() {
  gmFader = makeHFader($('#gm'), (v) => send({ type: 'master.grandmaster', value: v }));

  $('#conn').addEventListener('pointerdown', openDiagDialog);
  setupModalHintergrund();

  setupBlackoutSwipe();
}

/* Blackout durch Ziehen. Der Griff startet links (Blackout aus) oder rechts
 * (Blackout an) und muss ueber BO_SCHWELLE der Bahn gezogen werden. Ein
 * kuerzerer Weg federt zurueck und schaltet nichts. */
const BO_SCHWELLE = 0.8;

function setupBlackoutSwipe() {
  const bahn  = $('#blackout');
  const knopf = $('#bo-knob');
  const text  = $('#bo-text');

  let zieht = false, startX = 0, weg = 0, weite = 0, skala = 1;

  const an = () => !!(srv && srv.master.blackout);
  // Weg, den der Griff hat: Bahnbreite minus Griff und die 3 px Luft beidseits.
  const maxWeg = () => bahn.clientWidth - knopf.offsetWidth - 6;

  /* ev.clientX zaehlt in Bildschirmpixeln, translateX aber in Pixeln der
   * Buehne - und die ist skaliert (fitStage). Ohne diesen Faktor laeuft der
   * Griff mit falscher Geschwindigkeit unter dem Finger weg. */
  const buehnenSkala = () => {
    // offsetWidth, nicht clientWidth: getBoundingClientRect misst mit
    // Rahmen, clientWidth ohne. Mit clientWidth lag der Faktor bei dieser
    // Bahn (2 px Rahmen) um 1,8 % daneben und der Griff lief dem Finger
    // langsam davon.
    const r = bahn.getBoundingClientRect();
    return bahn.offsetWidth ? (r.width / bahn.offsetWidth) || 1 : 1;
  };

  /* Ruhelage: aus = links, an = rechts. */
  function setzen() {
    if (zieht) return;
    knopf.style.transform = `translateX(${an() ? maxWeg() : 0}px)`;
    text.style.opacity = '1';
    text.textContent = an() ? '◂ AUFHEBEN' : 'BLACKOUT ▸';
  }

  knopf.addEventListener('pointerdown', (ev) => {
    capture(knopf, ev);
    zieht = true;
    startX = ev.clientX;
    weite = maxWeg();
    skala = buehnenSkala();
    weg = 0;
    bahn.classList.add('zieht');
  });

  knopf.addEventListener('pointermove', (ev) => {
    if (!zieht) return;
    const roh = (ev.clientX - startX) / skala;
    // Aus dem Blackout heraus geht es nach links, hinein nach rechts.
    weg = an() ? clamp(roh, -weite, 0) : clamp(roh, 0, weite);
    knopf.style.transform = `translateX(${(an() ? weite : 0) + weg}px)`;
    text.style.opacity = String(1 - Math.min(1, Math.abs(weg) / weite * 1.6));
  });

  const los = () => {
    if (!zieht) return;
    zieht = false;
    bahn.classList.remove('zieht');
    if (weite > 0 && Math.abs(weg) / weite >= BO_SCHWELLE) {
      // Griff am Ziel stehen lassen. setzen() wuerde hier die alte Ruhelage
      // herstellen - der Server hat den neuen Zustand noch nicht bestaetigt,
      // und der Griff zuckte sichtbar zurueck, bevor er wieder vorsprang.
      const einschalten = !an();
      knopf.style.transform = `translateX(${einschalten ? weite : 0}px)`;
      text.style.opacity = '1';
      text.textContent = einschalten ? '◂ AUFHEBEN' : 'BLACKOUT ▸';
      send({ type: 'master.blackout', on: einschalten });
    } else {
      setzen();
    }
  };
  knopf.addEventListener('pointerup', los);
  knopf.addEventListener('pointercancel', los);

  window.addEventListener('resize', setzen);
  setzen();
  blackoutSetzen = setzen;
}

/* Wird von applyState gerufen, damit der Griff auch dann springt, wenn ein
 * anderes Geraet schaltet. */
let blackoutSetzen = () => {};

function setupLive() {
  pad = setupPad();

  const washW = 72;   // 3 Fader plus 2x8 px Abstand fuellen die Spalte
  zoomFader = makeFader({ name: 'Zoom', value: 0.5, width: washW, height: 386,
    onChange: (v) => send({ type: 'ml.zoom', value: v }) });
  dimFader = makeFader({ name: 'Dimmer', value: 0, width: washW, height: 386,
    onChange: (v) => send({ type: 'ml.dimmer', value: v }) });
  sensFader = makeFader({ name: 'Pad-Emp\u00ADfindlichkeit', value: 1, width: washW, height: 386, tint: 'var(--teal)',
    onChange: (v) => send({ type: 'settings.pad_sensitivity', value: v }) });

  $('#wash-faders').append(zoomFader.el, dimFader.el, sensFader.el);
}

/* ---------------------------------------------------------------------- */
/* Verbindungsfenster                                                      */
/* ---------------------------------------------------------------------- */

/* Zeigt die Kette Tablet -> WebSocket -> Server -> Art-Net -> Node, jeweils
 * mit dem, was sich messen laesst. Keine Ampeln ohne Messwert dahinter:
 * was der Client nicht wissen kann, steht auch nicht drin. */

const WS_ZUSTAND = ['verbindet', 'offen', 'schliesst', 'geschlossen'];

let diagTimer = null;
let diagOffen = false;   // nur dann schliesst ein Tippen auf den Hintergrund

function alter(ms) {
  if (ms == null) return '–';
  if (ms < 1000) return Math.round(ms) + ' ms';
  if (ms < 90000) return (ms / 1000).toFixed(1) + ' s';
  const min = Math.floor(ms / 60000);
  if (min < 90) return min + ' min';
  return Math.floor(min / 60) + ' h ' + (min % 60) + ' min';
}

/* Gemessene Rate der state-Nachrichten - nicht die eingestellte. */
function gemesseneStateHz() {
  if (statesSeit.length < 2) return null;
  const spanne = statesSeit[statesSeit.length - 1] - statesSeit[0];
  if (spanne <= 0) return null;
  return ((statesSeit.length - 1) / spanne) * 1000;
}

function zeile(k, v, warn) {
  const r = el('div', 'drow' + (warn ? ' warn' : ''));
  r.append(el('div', 'k', k), el('div', 'v', v));
  return r;
}

function openDiagDialog() {
  const d = dialog('Verbindung', 'Was gerade tatsächlich läuft — und die Schalter dafür.');
  const body = el('div', 'diag');
  d.appendChild(body);

  const reihe = el('div', 'row');
  const neuladen = el('div', 'btn primary', 'Seite neu laden');
  neuladen.addEventListener('pointerdown', () => location.reload());

  const hart = el('div', 'btn', 'Zwischenspeicher leeren');
  hart.addEventListener('pointerdown', async () => {
    // Nach einem Update haengt das Tablet sonst am alten Stand: Service
    // Worker abmelden, Caches loeschen, dann neu laden.
    try {
      const regs = await navigator.serviceWorker?.getRegistrations?.() || [];
      await Promise.all(regs.map(r => r.unregister()));
      const keys = await caches?.keys?.() || [];
      await Promise.all(keys.map(k => caches.delete(k)));
    } catch (err) { /* dann eben nur neu laden */ }
    location.reload();
  });

  const neuVerbinden = el('div', 'btn', 'Neu verbinden');
  neuVerbinden.addEventListener('pointerdown', () => {
    // Ein halbtoter Socket meldet sich nicht von selbst. Schliessen loest
    // den bestehenden Wiederverbindungspfad aus.
    if (ws) ws.close();
    diagSchliessen();
    toast('Verbindung wird neu aufgebaut …');
  });

  const sp = el('div', 'spacer');
  const zu = el('div', 'btn', 'Schließen');
  zu.addEventListener('pointerdown', diagSchliessen);

  reihe.append(neuladen, hart, neuVerbinden, sp, zu);
  d.appendChild(el('div', 'hr'));
  d.appendChild(reihe);

  diagOffen = true;
  openModal(d);

  zeichneDiag();
  send({ type: 'diag.request' });
  // Solange das Fenster offen ist, eine Auffrischung pro Sekunde.
  clearInterval(diagTimer);
  diagTimer = setInterval(() => {
    if (!$('#modal').classList.contains('on')) { clearInterval(diagTimer); diagTimer = null; return; }
    zeichneDiag();
    send({ type: 'diag.request' });
  }, 1000);
}

function diagSchliessen() {
  clearInterval(diagTimer);
  diagTimer = null;
  closeModal();
}

/* Tippen neben das Fenster schliesst es - aber nur dieses. In den anderen
 * Dialogen steckt Eingabe, die ein Fehlgriff sonst verwerfen wuerde. Der
 * Zuhoerer haengt genau einmal am #modal: vorher wurde er bei jedem Oeffnen
 * neu angehaengt und schloss danach auch fremde Dialoge. */
function setupModalHintergrund() {
  $('#modal').addEventListener('pointerdown', (ev) => {
    if (diagOffen && ev.target === $('#modal')) diagSchliessen();
  });
}

function zeichneDiag() {
  const body = $('#modal .diag');
  if (!body) return;
  body.textContent = '';

  /* --- Tablet -------------------------------------------------------- */
  const gruppe1 = el('div', 'dgrp');
  gruppe1.appendChild(el('div', 'dcap', 'DIESES GERÄT'));
  const skala = getComputedStyle(document.documentElement).getPropertyValue('--scale').trim();
  gruppe1.append(
    zeile('Stand der Oberfläche', appVersion()),
    zeile('Service Worker', swZustand()),
    zeile('Anzeige', `${innerWidth}×${innerHeight} · Faktor ${(+skala || 1).toFixed(3)} · DPR ${devicePixelRatio}`),
    zeile('Controller', gp.index === null ? 'nicht verbunden' : `${gp.name}${gp.standard ? '' : ' (fremde Belegung)'}`)
  );

  /* --- Verbindung ---------------------------------------------------- */
  const gruppe2 = el('div', 'dgrp');
  gruppe2.appendChild(el('div', 'dcap', 'VERBINDUNG'));
  const zustand = ws ? WS_ZUSTAND[ws.readyState] : 'keine';
  const hz = gemesseneStateHz();
  const staleMs = lastStateAt ? Date.now() - lastStateAt.getTime() : null;
  gruppe2.append(
    zeile('Adresse', ws ? ws.url : wsUrl()),
    zeile('Zustand', zustand, zustand !== 'offen'),
    zeile('Verbunden seit', helloAt ? alter(Date.now() - helloAt.getTime()) : '–'),
    zeile('Wiederverbindungen', String(reconnectTries)),
    zeile('Protokoll', serverProtocol == null ? '–' : `v${serverProtocol} (Client v${PROTOCOL})`,
          serverProtocol != null && serverProtocol !== PROTOCOL),
    // Ueber 3 s ohne Zustand heisst: auch der Keepalive bleibt aus.
    zeile('Letzter Zustand', staleMs == null ? '–' : 'vor ' + alter(staleMs), staleMs != null && staleMs > 3000),
    // Der Server sendet nur bei Aenderung, plus einen Keepalive je Sekunde
    // (STATE_KEEPALIVE_MS). Im Leerlauf ist 1/s also richtig und kein Fehler -
    // ohne diesen Zusatz liest sich die Zahl neben "Zustand 10/s" wie einer.
    zeile('Zustand empfangen', hz == null ? '–' : `${hz.toFixed(1)}/s · nur bei Änderung`),
    zeile('Verworfene Pakete', String(verworfeneStates), verworfeneStates > 0)
  );

  body.append(gruppe1, gruppe2);

  /* --- Server und Art-Net -------------------------------------------- */
  if (!letzteDiag) {
    body.appendChild(el('div', 'dhint', 'Server antwortet nicht auf die Abfrage.'));
    return;
  }
  const sv = letzteDiag.server, an = letzteDiag.artnet, db = letzteDiag.db;

  const gruppe3 = el('div', 'dgrp');
  gruppe3.appendChild(el('div', 'dcap', 'SERVER'));
  gruppe3.append(
    zeile('Version', sv.version),
    zeile('Läuft seit', alter(sv.now - sv.started)),
    zeile('Verbundene Geräte', String(sv.clients)),
    zeile('Takt', `DMX ${sv.tick_hz}/s · Zustand höchstens ${sv.state_hz}/s`),
    zeile('Datenbank', db.ok ? `erreichbar (${db.name})` : `nicht erreichbar – ${db.error || 'unbekannt'}`, !db.ok)
  );

  const gruppe4 = el('div', 'dgrp');
  gruppe4.appendChild(el('div', 'dcap', 'ART-NET'));
  const seitPaket = an.last_ts ? sv.now - an.last_ts : null;
  gruppe4.append(
    zeile('Ziel', `${an.target}:${an.port} · ${an.mode}`),
    zeile('Universe', String(an.universe)),
    zeile('Pakete gesendet', an.sent.toLocaleString('de-DE')),
    zeile('Letztes Paket', seitPaket == null ? 'noch keins' : 'vor ' + alter(seitPaket),
          seitPaket == null || seitPaket > 2000),
    zeile('Sendefehler', an.errors ? `${an.errors} – ${an.last_error || ''}` : '0', an.errors > 0)
  );

  body.append(gruppe3, gruppe4);
}

/* Aus der Adresse des geladenen Skripts: index.php haengt dort die Dateizeit
 * an. Damit ist am Tablet ablesbar, ob es auf dem neuen Stand laeuft. */
function appVersion() {
  const skript = [...document.scripts].find(s => s.src && s.src.includes('app.js'));
  const v = skript && new URL(skript.src).searchParams.get('v');
  if (!v) return 'unbekannt';
  return new Date(Number(v) * 1000).toLocaleString('de-DE');
}

function swZustand() {
  if (!('serviceWorker' in navigator)) return 'nicht unterstützt';
  const c = navigator.serviceWorker.controller;
  return c ? 'aktiv' : 'nicht aktiv (kein App-Modus)';
}

/* ---------------------------------------------------------------------- */
/* Controller (Gamepad-API)                                                */
/* ---------------------------------------------------------------------- */

/* Belegung (Standard-Mapping):
 *   Linker Stick    Pan/Tilt schnell
 *   Rechter Stick   Pan/Tilt langsam (beide addieren sich)
 *   L1 / R1         Dimmer runter / hoch, gehalten. Doppeltipp faehrt in
 *                   GP_DIM_TAP_SEC auf Minimum bzw. Maximum.
 *   L2 / R2         Zoom enger / weiter, analog zur Druckstaerke.
 *   Steuerkreuz     Position 1..4 - oben ist 1, dann im Uhrzeigersinn.
 *
 * Der Controller bedient immer das Moving Light, unabhaengig von der
 * geoeffneten Seite. */

const GP_DEADZONE      = 0.12;   // Ruhelage der Sticks
const GP_STICK_FAST    = 1.00;   // linker Stick
const GP_STICK_SLOW    = 0.30;   // rechter Stick
/* Feste Empfindlichkeit des Controllers, unabhaengig vom Pad-Fader. Der
 * Stickweg ist bereits die Dosierung; eine zweite, am Bildschirm verstellte
 * Skala daruebergelegt macht den Controller unberechenbar. Geht als Feld in
 * ml.move mit (PROTOKOLL.md §3.2). */
const GP_SENSITIVITY   = 0.25;
const GP_DIM_HOLD_SEC  = 3.0;    // voller Dimmerweg bei gehaltener Taste
const GP_DIM_TAP_SEC   = 1.0;    // Doppeltipp: Rampe auf Minimum/Maximum
const GP_ZOOM_HOLD_SEC = 2.5;    // voller Zoomweg bei ganz gedruecktem Trigger
const GP_DOUBLE_MS     = 320;    // Fenster fuer den Doppeltipp
const GP_TRIGGER_AN    = 0.10;   // ab hier gilt ein Trigger als gedrueckt

/* Standard-Mapping der Gamepad-API. Meldet der Browser ein anderes Mapping,
 * stimmen die Nummern nicht - dann sagen wir das in der Kopfzeile, statt
 * stumm das Falsche zu schicken. */
const GP_B = { L1: 4, R1: 5, L2: 6, R2: 7, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 };

/* Steuerkreuz auf die ersten vier Positionen: oben = 1, im Uhrzeigersinn. */
const GP_DPAD_SLOT = { [GP_B.UP]: 1, [GP_B.RIGHT]: 2, [GP_B.DOWN]: 3, [GP_B.LEFT]: 4 };

const gp = {
  index: null,          // Index im getGamepads()-Feld
  name: '',
  standard: true,
  letzteTasten: new Map(),   // Tastennummer -> gedrueckt (fuer Flanken)
  letzterTipp: new Map(),    // Tastennummer -> Zeitpunkt (Doppeltipp)
  letzteZeit: 0,
  bewegt: false,        // ml.move laeuft gerade
  letzterMove: 0,
  // Dimmer und Zoom fuehren wir waehrend der Bedienung selbst, sonst
  // schreibt der 10-Hz-Zustand vom Server den aelteren Wert zurueck und
  // der Wert zittert - dasselbe Problem wie beim Fadergriff.
  dim:  { fuehrt: false, wert: 0, rampe: null, gesendet: 0 },
  zoom: { fuehrt: false, wert: 0.5, gesendet: 0 }
};

function setupGamepad() {
  if (!('getGamepads' in navigator)) {
    $('#gp-label').textContent = 'vom Browser nicht unterstützt';
    return;
  }
  window.addEventListener('gamepadconnected',    (e) => gamepadAn(e.gamepad));
  window.addEventListener('gamepaddisconnected', (e) => gamepadAb(e.gamepad));

  // Beim Neuladen der Seite ist ein schon gekoppeltes Pad oft bereits da,
  // ohne dass ein Ereignis kommt.
  for (const p of navigator.getGamepads?.() || []) if (p) gamepadAn(p);

  gp.letzteZeit = performance.now();
  requestAnimationFrame(gamepadTick);
}

function gamepadAn(pad) {
  gp.index = pad.index;
  gp.name = (pad.id || 'Controller').replace(/\s*\([^)]*\)\s*$/, '').trim();
  gp.standard = pad.mapping === 'standard';
  document.body.classList.add('gp-an');
  $('#gp-label').textContent = gp.standard
    ? (gp.name || 'verbunden')
    : `${gp.name} – fremde Belegung`;
}

function gamepadAb(pad) {
  if (pad && gp.index !== null && pad.index !== gp.index) return;
  gp.index = null;
  document.body.classList.remove('gp-an', 'gp-aktiv');
  $('#gp-label').textContent = 'nicht verbunden';
  // Ein Kopf, der gerade faehrt, muss stehenbleiben. Der Totmann im Server
  // faengt es zwar nach 400 ms ab, aber gesagt ist besser als abgelaufen.
  if (gp.bewegt) { send({ type: 'ml.move', pan_speed: 0, tilt_speed: 0 }); gp.bewegt = false; }
}

function gamepadTick(jetzt) {
  requestAnimationFrame(gamepadTick);

  const dt = Math.min(0.1, (jetzt - gp.letzteZeit) / 1000);   // Sprung nach Tab-Wechsel deckeln
  gp.letzteZeit = jetzt;

  const pad = gp.index === null ? null : (navigator.getGamepads?.() || [])[gp.index];
  if (!pad) {
    if (gp.index !== null) gamepadAb(null);
    return;
  }
  // Bedienung gesperrt: bei getrennter Verbindung nichts schicken.
  if (document.body.classList.contains('offline')) return;

  const achse = (i) => {
    const v = pad.axes[i] || 0;
    return Math.abs(v) < GP_DEADZONE ? 0 : v;
  };
  const taste = (i) => !!(pad.buttons[i] && pad.buttons[i].pressed);
  const druck = (i) => (pad.buttons[i] ? pad.buttons[i].value : 0);

  gamepadSticks(achse, jetzt);
  gamepadDimmer(taste, jetzt, dt);
  gamepadZoom(druck, dt);
  gamepadDpad(taste);

  merkeTasten(pad);
}

/* ---- Pan/Tilt --------------------------------------------------------- */

function gamepadSticks(achse, jetzt) {
  // Achse 1 und 3 zeigen nach unten positiv; Tilt zaehlt nach oben.
  let vx = achse(0) * GP_STICK_FAST + achse(2) * GP_STICK_SLOW;
  let vy = -(achse(1) * GP_STICK_FAST + achse(3) * GP_STICK_SLOW);
  vx = clamp(vx, -1, 1);
  vy = clamp(vy, -1, 1);

  const faehrt = vx !== 0 || vy !== 0;
  document.body.classList.toggle('gp-aktiv', faehrt);

  if (faehrt) {
    // Auffrischen wie beim Pad: der Server setzt die Geschwindigkeit nach
    // ML_MOVE_TIMEOUT_MS von selbst auf 0 (PROTOKOLL.md §3.2).
    if (jetzt - gp.letzterMove >= 1000 / MOVE_HZ) {
      gp.letzterMove = jetzt;
      send({ type: 'ml.move', pan_speed: vx, tilt_speed: vy, sensitivity: GP_SENSITIVITY });
    }
    gp.bewegt = true;
  } else if (gp.bewegt) {
    gp.bewegt = false;
    send({ type: 'ml.move', pan_speed: 0, tilt_speed: 0 });
  }
}

/* ---- Dimmer ----------------------------------------------------------- */

function gamepadDimmer(taste, jetzt, dt) {
  const runter = taste(GP_B.L1), hoch = taste(GP_B.R1);

  // Doppeltipp: auf Minimum bzw. Maximum fahren.
  for (const [nr, ziel] of [[GP_B.L1, 0], [GP_B.R1, 1]]) {
    if (!flanke(nr, taste(nr))) continue;
    const vorher = gp.letzterTipp.get(nr) || 0;
    gp.letzterTipp.set(nr, jetzt);
    if (jetzt - vorher <= GP_DOUBLE_MS) {
      gp.dim.fuehrt = true;
      gp.dim.rampe = { von: gp.dim.wert, ziel, start: jetzt };
      gp.letzterTipp.delete(nr);   // kein Dreifach-Tipp
    }
  }

  if (gp.dim.rampe) {
    const p = Math.min(1, (jetzt - gp.dim.rampe.start) / (GP_DIM_TAP_SEC * 1000));
    gp.dim.wert = gp.dim.rampe.von + (gp.dim.rampe.ziel - gp.dim.rampe.von) * p;
    sendeDimmer(jetzt, p >= 1);
    if (p >= 1) { gp.dim.rampe = null; gp.dim.fuehrt = false; }
    return;
  }

  if (runter === hoch) {          // beide oder keine: nichts tun
    gp.dim.fuehrt = false;
    return;
  }
  gp.dim.fuehrt = true;
  const richtung = hoch ? 1 : -1;
  gp.dim.wert = clamp01(gp.dim.wert + richtung * dt / GP_DIM_HOLD_SEC);
  sendeDimmer(jetzt, false);
}

function sendeDimmer(jetzt, sofort) {
  if (!sofort && jetzt - gp.dim.gesendet < FADER_SEND_MS) return;
  gp.dim.gesendet = jetzt;
  send({ type: 'ml.dimmer', value: gp.dim.wert });
}

/* ---- Zoom ------------------------------------------------------------- */

function gamepadZoom(druck, dt) {
  const enger = druck(GP_B.L2), weiter = druck(GP_B.R2);
  const netto = (weiter > GP_TRIGGER_AN ? weiter : 0) - (enger > GP_TRIGGER_AN ? enger : 0);
  if (netto === 0) { gp.zoom.fuehrt = false; return; }

  gp.zoom.fuehrt = true;
  gp.zoom.wert = clamp01(gp.zoom.wert + netto * dt / GP_ZOOM_HOLD_SEC);

  const jetzt = performance.now();
  if (jetzt - gp.zoom.gesendet < FADER_SEND_MS) return;
  gp.zoom.gesendet = jetzt;
  send({ type: 'ml.zoom', value: gp.zoom.wert });
}

/* ---- Steuerkreuz ------------------------------------------------------ */

function gamepadDpad(taste) {
  for (const nr of [GP_B.UP, GP_B.RIGHT, GP_B.DOWN, GP_B.LEFT]) {
    if (!flanke(nr, taste(nr))) continue;
    const slot = GP_DPAD_SLOT[nr];
    const p = library.positions.find(x => x.slot === slot);
    if (!p || !p.occupied) { toast(`Position ${slot} ist leer.`, true); continue; }
    send({ type: 'position.recall', slot });
    toast(`Position ${slot}: ${p.name || ''}`.trim());
  }
}

/* ---- Hilfen ----------------------------------------------------------- */

/* true genau in dem Durchlauf, in dem die Taste neu gedrueckt wurde. */
function flanke(nr, gedrueckt) {
  return gedrueckt && !gp.letzteTasten.get(nr);
}

function merkeTasten(pad) {
  for (let i = 0; i < pad.buttons.length; i++) {
    gp.letzteTasten.set(i, !!(pad.buttons[i] && pad.buttons[i].pressed));
  }
}

function setupTabs() {
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('pointerdown', () => showPage(tab.dataset.page));
  }
}

function setupProgrammerBar() {
  $('#prog-clear').addEventListener('pointerdown', () => {
    send({ type: 'programmer.clear' });
    setEditing(null);
    toast('Programmer geleert.');
  });
  $('#patch-add').addEventListener('pointerdown', () => openFixtureDialog(null));
  $('#prog-all').addEventListener('pointerdown', () => selectAllFixtures(true));
  $('#prog-none').addEventListener('pointerdown', () => selectAllFixtures(false));

  $('#prog-save').addEventListener('pointerdown', () => {
    if (editingPreset) {
      // Zurueck in dasselbe Preset. preset.save mit preset_id ersetzt die
      // Kanalwerte durch den Programmer - genau das ist hier gemeint.
      // Den Programmer leert danach der Server (PROTOKOLL.md §3.3).
      send({ type: 'preset.save', preset_id: editingPreset.id, name: editingPreset.name,
             page: PRESET_PAGE, fader_index: editingPreset.fader_index });
      toast(`„${editingPreset.name}“ aktualisiert.`);
      setEditing(null);
      showPage('live');
      return;
    }
    // Kam der Nutzer ueber einen leeren Fader hierher, ist dessen Platz
    // schon vorgewaehlt.
    askSlot(pendingSlot || 1, null);
  });
}

/* ---------------------------------------------------------------------- */
/* Buehne auf den Schirm rechnen                                          */
/* ---------------------------------------------------------------------- */

// Entwurfsmass des Pults. Alle Kachelmasse in app.css beziehen sich darauf.
const STAGE_H     = 800;
const STAGE_MIN_W = 1280;   // schmaler passt die Live-Zeile nicht mehr
const STAGE_MAX_W = 1600;   // darueber wuerde die Positionsspalte nur leerlaufen

// Hoehe gibt den Massstab vor, die Breite folgt dem Seitenverhaeltnis des
// Geraets. Auf 16:10 - also auch dem OnePlus Pad Lite - kommt genau die
// Entwurfsflaeche 1280 x 800 heraus, randlos und ohne Balken.
function fitStage() {
  const fit = $('#fit');
  const w = fit.clientWidth, h = fit.clientHeight;
  if (!w || !h) return;

  let scale = h / STAGE_H;
  const canvasW = Math.min(STAGE_MAX_W, Math.max(STAGE_MIN_W, Math.round(w / scale)));
  // Reicht die Breite dafuer nicht (hochkant, sehr quadratische Schirme),
  // bestimmt stattdessen sie den Massstab. Dann bleibt oben und unten Rand.
  if (canvasW * scale > w) scale = w / canvasW;

  const root = document.documentElement.style;
  root.setProperty('--canvas-w', canvasW + 'px');
  root.setProperty('--scale', String(scale));
}

function setupStage() {
  fitStage();
  window.addEventListener('resize', fitStage);
  window.addEventListener('orientationchange', fitStage);
  // Beim Wechsel in den Vollbildmodus der App aendert sich nur das
  // visualViewport, nicht immer window - deshalb beides beobachten.
  if (window.visualViewport) window.visualViewport.addEventListener('resize', fitStage);
}

window.addEventListener('DOMContentLoaded', () => {
  setupStage();
  setupGamepad();
  setupTabs();
  setupHeader();
  setupLive();
  setupProgrammerBar();
  connect();
});
