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
const POS_HOLD_MS    = 600;   // Halten = speichern
const BLACKOUT_HOLD  = 2000;  // Blackout gegen Fehlgriff sichern
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
  // Ziel sichtbar machen: bei Verbindungsproblemen ist die wichtigste
  // Frage, welche Adresse das Geraet ueberhaupt anspricht.
  const url = wsUrl();
  $('#conn-sub').textContent = url;
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
      $('#conn-sub').textContent = 'atrium-light · Universe 0';
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
      if (typeof msg.seq === 'number' && msg.seq <= lastSeq) return;
      lastSeq = msg.seq;
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
    tint = null, locked = false, sub = false, onChange = null, onHold = null
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

  if (tint) fill.style.background = tint;
  track.append(rail, fill, grip);
  root.append(nameEl, track, valEl);
  if (subEl) root.appendChild(subEl);

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
  }

  if (!locked) {
    let lastSent = 0, holdTimer = null, moved = false;

    const valueFromEvent = (ev) => {
      const r = track.getBoundingClientRect();
      return clamp01(1 - (ev.clientY - r.top) / r.height);
    };

    root.addEventListener('pointerdown', (ev) => {
      capture(root, ev);
      api.holding = true;
      moved = false;
      root.classList.add('holding');
      if (onHold) holdTimer = setTimeout(() => { if (!moved) onHold(); }, POS_HOLD_MS);
      // Kein sofortiger Sprung auf die Fingerposition: das erste
      // pointermove uebernimmt. So laesst sich der Fader auch nur
      // "anfassen", ohne den Wert zu veraendern.
    });

    root.addEventListener('pointermove', (ev) => {
      if (!api.holding) return;
      moved = true;
      clearTimeout(holdTimer);
      api.value = valueFromEvent(ev);
      paint();
      const now = performance.now();
      if (onChange && now - lastSent >= FADER_SEND_MS) {
        lastSent = now;
        onChange(api.value);
      }
    });

    const end = () => {
      if (!api.holding) return;
      clearTimeout(holdTimer);
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
      value: (srv && srv.preset_levels && srv.preset_levels[p.id]) || 0,
      onChange: (v) => send({ type: 'preset.fader', preset_id: p.id, level: v }),
      onHold: () => openPresetDialog(p)
    });
    presetFaders.set(p.id, f);
    bank.appendChild(f.el);
    f.setValue(f.value, true);
  }
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
      name: ROLE_LABEL[role] || role,
      value: 0, width: 76, height: 196,
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
  if (sensFader) sensFader.setValue(s.pad_sensitivity);
  if (gmFader)   gmFader.setValue(s.master.grandmaster);

  document.body.classList.toggle('blackout', !!s.master.blackout);
  $('#blackout-hint').textContent = s.master.blackout ? 'aktiv · zum Lösen halten' : '2 s halten';

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
function closeModal() { $('#modal').classList.remove('on'); $('#modal').textContent = ''; }

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

  const del = el('div', 'btn danger', 'Löschen');
  del.addEventListener('pointerdown', () => {
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

  const del = el('div', 'btn danger', 'Löschen');
  del.addEventListener('pointerdown', () => {
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
  const del = el('div', 'btn danger', 'Löschen');
  del.addEventListener('pointerdown', () => { send({ type: 'position.delete', slot: p.slot }); closeModal(); });

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
    ? `<span style="color:var(--red)">Adressüberschneidung: ${[...konflikte].join(', ')}</span>`
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
    const del = el('div', 'btn danger', 'Löschen');
    del.addEventListener('pointerdown', () => {
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

  const b = $('#blackout');
  const bar = $('#blackout-hold');
  let timer = null, start = 0, raf = null;

  b.addEventListener('pointerdown', () => {
    start = performance.now();
    const tick = () => {
      const p = Math.min(1, (performance.now() - start) / BLACKOUT_HOLD);
      bar.style.width = (p * 100) + '%';
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    timer = setTimeout(() => {
      const on = !(srv && srv.master.blackout);
      send({ type: 'master.blackout', on });
      bar.style.width = '0';
    }, BLACKOUT_HOLD);
  });
  const cancel = () => { clearTimeout(timer); cancelAnimationFrame(raf); bar.style.width = '0'; };
  b.addEventListener('pointerup', cancel);
  b.addEventListener('pointercancel', cancel);
}

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
  setupTabs();
  setupHeader();
  setupLive();
  setupProgrammerBar();
  connect();
});
