// Erzeugt die .dc.html-Artboards fuer die Design-Canvas "Atrium Light Pult".
// Werte stammen aus dem echten Projekt: Kanalnamen aus database/seed.test.sql,
// Preset-Namen aus der Testdatenbank, Fadermasse aus frontend/index.php
// (FADER_WIDTH_PX 80, FADER_TRACK_HEIGHT_PX 280, FADER_THUMB_SIZE_PX 44).
import { writeFileSync } from 'node:fs';

/* ---------- Tokens ---------------------------------------------------- */
const C = {
  bg:     '#131211',
  panel:  '#1C1A17',
  panel2: '#232019',
  sunk:   '#100F0D',
  line:   '#34302A',
  line2:  '#4A443B',
  txt:    '#ECE7DE',
  txt2:   '#A49B8C',
  txt3:   '#6B6357',
  amber:  '#E9A63F',
  amberHi:'#F8D9A0',
  teal:   '#4FB3AC',
  red:    '#D6503C',
  green:  '#62A94A',
  blue:   '#4A7FD6'
};
const SANS = `'IBM Plex Sans',system-ui,-apple-system,sans-serif`;
const MONO = `'IBM Plex Mono',ui-monospace,'SFMono-Regular',monospace`;

const HELMET = `<helmet>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
  <style>
    body { margin: 0; background: ${C.bg}; color: ${C.txt}; font-family: ${SANS}; -webkit-font-smoothing: antialiased; }
    a { color: ${C.amber}; } a:hover { color: ${C.amberHi}; }
  </style>
</helmet>`;

const doc = (body) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
${HELMET}
${body}
</x-dc>
</body>
</html>
`;

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/* ---------- Bausteine -------------------------------------------------- */

// Ein Fader. Der helle Strich ist der Serverwert, der Griff sitzt darauf --
// so bleibt lesbar, dass die Stellung vom Server kommt und nicht vom Finger.
function fader({ name, pct, sub = null, w = 72, h = 188, track = 120, tint = C.amber, locked = false }) {
  const v = Math.round(pct * track);
  const handleBottom = clamp(v - 15, -4, track - 26);
  const dim = locked ? 'opacity:.4;' : '';
  const handle = locked ? '' : `
      <div style="position:absolute;left:-2px;right:-2px;bottom:${handleBottom}px;height:30px;background:${C.panel2};border:1px solid ${C.line2};border-radius:6px;display:flex;align-items:center;">
        <div style="width:100%;height:2px;background:${C.amberHi};"></div>
      </div>`;
  return `
  <div style="${dim}width:${w}px;height:${h}px;background:${C.panel};border:1px solid ${C.line};border-radius:10px;padding:8px 6px;display:flex;flex-direction:column;align-items:center;gap:6px;box-sizing:border-box;">
    <div style="font:500 11px/1.25 ${SANS};color:${C.txt2};text-align:center;height:28px;overflow:hidden;">${name}</div>
    <div style="position:relative;width:100%;flex-grow:1;">
      <div style="position:absolute;left:50%;transform:translateX(-50%);top:0;bottom:0;width:14px;background:${C.sunk};border:1px solid #2A2620;border-radius:8px;"></div>
      <div style="position:absolute;left:50%;transform:translateX(-50%);bottom:0;width:14px;height:${v}px;background:${tint};border-radius:8px;"></div>${handle}
    </div>
    <div style="font:600 13px/1 ${MONO};color:${locked ? C.txt3 : C.txt};">${Math.round(pct * 100)}%</div>
    ${sub ? `<div style="font:400 11px/1 ${MONO};color:${C.txt3};">${sub}</div>` : ''}
  </div>`;
}

function emptyFader({ w = 72, h = 188, label = 'frei' }) {
  return `
  <div style="width:${w}px;height:${h}px;border:1px dashed ${C.line};border-radius:10px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;">
    <div style="font:400 11px/1 ${SANS};color:${C.txt3};">${label}</div>
  </div>`;
}

const iconLock = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="${C.txt3}" stroke-width="2" stroke-linecap="round"><rect x="4" y="10" width="16" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3"></path></svg>`;
const iconBolt = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"></path></svg>`;

function sectionTitle(text, right = '') {
  return `<div style="display:flex;justify-content:space-between;align-items:baseline;height:20px;">
    <div style="font:600 12px/1 ${SANS};letter-spacing:.08em;color:${C.txt2};text-transform:uppercase;">${text}</div>
    <div style="font:400 11px/1 ${MONO};color:${C.txt3};">${right}</div>
  </div>`;
}

// Kopfzeile: Ampel links, Grandmaster + Blackout rechts.
function header({ connected = true, gm = 1.0, blackout = false } = {}) {
  const dot = connected ? C.green : C.red;
  const gmPct = Math.round(gm * 100);
  return `
<div style="height:68px;flex-shrink:0;background:${C.panel};border-bottom:1px solid ${C.line};display:flex;align-items:center;padding:0 16px;gap:16px;box-sizing:border-box;">

  <div style="display:flex;align-items:center;gap:10px;">
    <div style="width:14px;height:14px;border-radius:50%;background:${dot};box-shadow:0 0 0 4px ${dot}22;"></div>
    <div>
      <div style="font:600 13px/1.2 ${SANS};color:${C.txt};">${connected ? 'Verbunden' : 'Getrennt'}</div>
      <div style="font:400 11px/1.2 ${MONO};color:${C.txt3};">atrium-light · Universe 0</div>
    </div>
  </div>

  <div style="width:1px;height:36px;background:${C.line};"></div>

  <div style="display:flex;flex-direction:column;gap:3px;">
    <div style="font:400 11px/1 ${MONO};color:${C.txt3};">Zustand vom Server</div>
    <div style="display:flex;align-items:center;gap:8px;">
      <div style="font:500 12px/1 ${MONO};color:${C.teal};">10/s</div>
      <div style="font:400 11px/1 ${SANS};color:${C.txt3};">laufend aufgefrischt</div>
    </div>
  </div>

  <div style="flex-grow:1;"></div>

  <div style="display:flex;align-items:center;gap:12px;">
    <div style="font:500 12px/1 ${SANS};color:${C.txt2};">Grandmaster</div>
    <div style="position:relative;width:220px;height:40px;background:${C.sunk};border:1px solid ${C.line};border-radius:8px;overflow:hidden;">
      <div style="position:absolute;left:0;top:0;bottom:0;width:${gmPct}%;background:${C.amber};opacity:.85;"></div>
      <div style="position:absolute;left:${gmPct}%;top:0;bottom:0;width:2px;background:${C.amberHi};"></div>
      <div style="position:absolute;left:${clamp(gmPct - 6, 0, 88)}%;top:2px;bottom:2px;width:44px;background:${C.panel2};border:1px solid ${C.line2};border-radius:6px;"></div>
    </div>
    <div style="width:52px;font:600 15px/1 ${MONO};color:${C.txt};text-align:right;">${gmPct}%</div>
  </div>

  <div style="width:1px;height:36px;background:${C.line};"></div>

  <div style="width:182px;height:48px;border-radius:10px;border:2px solid ${blackout ? C.red : '#5A2B22'};background:${blackout ? C.red : '#2A1712'};display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;">
    <div style="display:flex;align-items:center;gap:8px;color:${blackout ? '#1A0E0B' : C.red};">
      ${iconBolt}
      <div style="font:600 15px/1 ${SANS};letter-spacing:.06em;">BLACKOUT</div>
    </div>
    <div style="font:400 10px/1 ${SANS};color:${blackout ? '#1A0E0B' : '#8A4C3D'};">${blackout ? 'aktiv · zum Lösen halten' : '2 s halten'}</div>
  </div>
</div>`;
}

/* ---------- Inhalte aus dem echten Projekt ----------------------------- */

// Preset-Namen: die ersten beiden stehen so in der Testdatenbank,
// der Rest ist Platzhalter fuer ein realistisch gefuelltes Pult.
const PRESETS = [
  { n: 'Dimmer Full', v: 0.00 }, { n: 'LED Warm', v: 0.62 },
  { n: 'Grundlicht', v: 0.85 },  { n: 'Empfang', v: 0.00 },
  { n: 'Abend', v: 0.40 },       { n: 'Putzlicht', v: 0.00 },
  { n: 'Vortrag', v: 0.00 },     { n: 'Bar', v: 0.25 },
  { n: 'Foyer kalt', v: 0.00 },  { n: 'Foyer warm', v: 0.70 },
  { n: 'Akzent Treppe', v: 0.00 }, { n: 'Galerie', v: 0.00 },
  null, null, null, null
];

// 9 Positionsslots. Slot 5 wird gerade angefahren (state.ml.fading).
const POSITIONS = [
  { n: 'Empfang', f: '2.0 s' }, { n: 'Treppe', f: '3.0 s' }, { n: 'Galerie li', f: '2.0 s' },
  { n: 'Galerie re', f: '2.0 s' }, { n: 'Bar', f: '5.5 s' }, null,
  { n: 'Grundstellung', f: '4.0 s' }, null, null
];

/* ---------- Live-Screen ------------------------------------------------ */

function padBlock() {
  // Ist-Position des Kopfes. Ein Fahrtziel kann das Pad nicht zeigen:
  // state.ml.fading ist nur ein Boolean, Zielslot und Restzeit stehen nicht drin.
  const px = 0.38, py = 0.62;
  const S = 360;
  const cx = Math.round(px * S), cy = Math.round((1 - py) * S);
  return `
<div style="width:360px;display:flex;flex-direction:column;gap:10px;">
  ${sectionTitle('Moving Light', 'Ist-Position')}
  <div style="position:relative;width:360px;height:360px;background:${C.sunk};border:1px solid ${C.line};border-radius:12px;overflow:hidden;">
    <div style="position:absolute;left:0;right:0;top:50%;height:1px;background:#241F19;"></div>
    <div style="position:absolute;top:0;bottom:0;left:50%;width:1px;background:#241F19;"></div>
    <div style="position:absolute;left:0;right:0;top:25%;height:1px;background:#1C1813;"></div>
    <div style="position:absolute;left:0;right:0;top:75%;height:1px;background:#1C1813;"></div>
    <div style="position:absolute;top:0;bottom:0;left:25%;width:1px;background:#1C1813;"></div>
    <div style="position:absolute;top:0;bottom:0;left:75%;width:1px;background:#1C1813;"></div>

    <div style="position:absolute;left:${cx - 15}px;top:${cy - 15}px;width:30px;height:30px;border-radius:50%;background:${C.amber};box-shadow:0 0 0 8px ${C.amber}22, 0 0 20px ${C.amber}55;"></div>

    <div style="position:absolute;left:12px;top:12px;display:flex;align-items:center;gap:8px;padding:5px 10px;background:#0C0B0A;border:1px solid ${C.teal}66;border-radius:999px;">
      <div style="width:8px;height:8px;border-radius:50%;background:${C.teal};"></div>
      <div style="font:500 11px/1 ${MONO};color:${C.teal};">FAHRT LÄUFT</div>
    </div>

    <div style="position:absolute;left:0;right:0;bottom:8px;text-align:center;font:400 10px/1 ${MONO};color:${C.txt3};letter-spacing:.14em;">PAN</div>
    <div style="position:absolute;left:8px;top:50%;transform:translateY(-50%) rotate(-90deg);font:400 10px/1 ${MONO};color:${C.txt3};letter-spacing:.14em;">TILT</div>
  </div>
</div>`;
}

function padFaders(h = 380, track = 280) {
  return `
<div style="width:232px;display:flex;flex-direction:column;gap:10px;">
  ${sectionTitle('Wash', 'live')}
  <div style="display:flex;gap:8px;">
    ${fader({ name: 'Zoom', pct: 0.55, w: 72, h, track })}
    ${fader({ name: 'Dimmer', pct: 0.78, w: 72, h, track })}
    ${fader({ name: 'Pad-Empfind&shy;lichkeit', pct: 0.60, w: 72, h, track, tint: C.teal })}
  </div>
</div>`;
}

function positionsGrid(w = 624, ch = 118) {
  const cells = POSITIONS.map((p, i) => {
    const slot = i + 1;
    if (!p) {
      return `<div style="height:${ch}px;border:1px dashed ${C.line};border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;box-sizing:border-box;">
        <div style="font:600 15px/1 ${MONO};color:${C.txt3};">${slot}</div>
        <div style="font:400 11px/1 ${SANS};color:${C.txt3};">leer · halten zum Speichern</div>
      </div>`;
    }
    return `<div style="height:${ch}px;border:1px solid ${C.line2};border-radius:10px;background:${C.panel};padding:12px;display:flex;flex-direction:column;box-sizing:border-box;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;">
        <div style="font:600 12px/1 ${MONO};color:${C.txt3};">${slot}</div>
        <div style="font:400 11px/1 ${MONO};color:${C.txt3};">${p.f}</div>
      </div>
      <div style="flex-grow:1;display:flex;align-items:center;">
        <div style="font:500 16px/1.2 ${SANS};color:${C.txt};">${p.n}</div>
      </div>
    </div>`;
  }).join('\n    ');

  return `
<div style="width:${w}px;display:flex;flex-direction:column;gap:10px;">
  ${sectionTitle('Positionen', 'tippen = anfahren · halten = speichern')}
  <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:16px;">
    ${cells}
  </div>
</div>`;
}

function presetBank({ w = 1248, count = 16, fw = 72, fh = 188, track = 120, cols = 16 } = {}) {
  const items = PRESETS.slice(0, count).map((p, i) =>
    p ? fader({ name: p.n, pct: p.v, w: fw, h: fh, track })
      : emptyFader({ w: fw, h: fh, label: `Fader ${i + 1}` })
  ).join('\n    ');

  return `
<div style="width:${w}px;display:flex;flex-direction:column;gap:10px;">
  ${sectionTitle('Presets', '16 Plätze · lang drücken zum Speichern')}
  <div style="display:grid;grid-template-columns:repeat(${cols}, minmax(0, 1fr));gap:6px;">
    ${items}
  </div>
</div>`;
}

function liveScreen() {
  return `
<div style="width:1280px;height:800px;display:flex;flex-direction:column;background:${C.bg};box-sizing:border-box;overflow:hidden;">
  ${header()}
  <div style="flex-grow:1;padding:16px;display:flex;flex-direction:column;gap:16px;box-sizing:border-box;">
    <div style="display:flex;gap:16px;">
      ${padBlock()}
      ${padFaders()}
      ${positionsGrid()}
    </div>
    ${presetBank()}
  </div>
</div>`;
}

/* ---------- Live-Alternative: Pad links, Presets rechts ---------------- */

function liveAltScreen() {
  const bank = PRESETS.map((p, i) =>
    p ? fader({ name: p.n, pct: p.v, w: 70, h: 316, track: 236 })
      : emptyFader({ w: 70, h: 316, label: `Fader ${i + 1}` })
  ).join('\n      ');

  return `
<div style="width:1280px;height:800px;display:flex;flex-direction:column;background:${C.bg};box-sizing:border-box;overflow:hidden;">
  ${header()}
  <div style="flex-grow:1;padding:16px;display:flex;gap:16px;box-sizing:border-box;">

    <div style="width:608px;display:flex;flex-direction:column;gap:16px;">
      <div style="display:flex;gap:16px;">
        ${padBlock()}
        ${padFaders(380, 280)}
      </div>
      <div style="display:flex;flex-direction:column;gap:10px;">
        ${sectionTitle('Positionen', 'tippen = anfahren · halten = speichern')}
        <div style="display:grid;grid-template-columns:repeat(3, minmax(0, 1fr));gap:12px;">
          ${POSITIONS.map((p, i) => {
            const slot = i + 1;
            if (!p) return `<div style="height:92px;border:1px dashed ${C.line};border-radius:10px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:2px;">
              <div style="font:600 14px/1 ${MONO};color:${C.txt3};">${slot}</div>
              <div style="font:400 10px/1 ${SANS};color:${C.txt3};">leer</div>
            </div>`;
            return `<div style="height:92px;border:1px solid ${C.line2};border-radius:10px;background:${C.panel};padding:10px;display:flex;flex-direction:column;box-sizing:border-box;">
              <div style="display:flex;justify-content:space-between;align-items:baseline;">
                <div style="font:600 12px/1 ${MONO};color:${C.txt3};">${slot}</div>
                <div style="font:400 11px/1 ${MONO};color:${C.txt3};">${p.f}</div>
              </div>
              <div style="flex-grow:1;display:flex;align-items:center;"><div style="font:500 14px/1.2 ${SANS};color:${C.txt};">${p.n}</div></div>
            </div>`;
          }).join('\n          ')}
        </div>
      </div>
    </div>

    <div style="width:1px;background:${C.line};"></div>

    <div style="flex-grow:1;display:flex;flex-direction:column;gap:10px;">
      ${sectionTitle('Presets', '16 Plätze')}
      <div style="display:grid;grid-template-columns:repeat(8, minmax(0, 1fr));gap:6px;">
      ${bank}
      </div>
    </div>
  </div>
</div>`;
}

/* ---------- Programmer ------------------------------------------------- */

const DIMMERS = [
  { n: 'Dim 1', v: 0.00 }, { n: 'Dim 2', v: 0.00 }, { n: 'Dim 3', v: 0.72 },
  { n: 'Dim 4', v: 0.72 }, { n: 'Dim 5', v: 0.00 }, { n: 'Dim 6', v: 0.00 }
];
const RGB_FIXTURES = [
  { n: 'RGB 1', v: [1.00, 0.55, 0.20] },
  { n: 'RGB 2', v: [1.00, 0.55, 0.20] },
  { n: 'RGB 3', v: [0.00, 0.00, 0.00] },
  { n: 'RGB 4', v: [0.00, 0.00, 0.00] }
];
const ML_CHANNELS = [
  { n: 'Wash Pan', v: 0.38 }, { n: 'Wash Pan Fine', v: 0.12 },
  { n: 'Wash Tilt', v: 0.62 }, { n: 'Wash Tilt Fine', v: 0.44 },
  { n: 'Wash Zoom', v: 0.55 }, { n: 'Wash Dimmer', v: 0.78 }
];
const dmx = (v) => String(Math.round(v * 255)).padStart(3, ' ').replace(/ /g, ' ');

function card(title, right, inner, w, h) {
  return `
  <div style="width:${w}px;height:${h}px;background:${C.panel};border:1px solid ${C.line};border-radius:12px;padding:14px;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;">
    <div style="display:flex;justify-content:space-between;align-items:center;">
      <div style="font:600 13px/1 ${SANS};letter-spacing:.06em;color:${C.txt};text-transform:uppercase;">${title}</div>
      <div style="display:flex;align-items:center;gap:6px;font:400 11px/1 ${MONO};color:${C.txt3};">${right}</div>
    </div>
    ${inner}
  </div>`;
}

function programmerScreen() {
  const dimFaders = DIMMERS.map(d =>
    fader({ name: d.n, pct: d.v, sub: dmx(d.v), w: 80, h: 210, track: 132 })
  ).join('\n      ');

  const mlFaders = ML_CHANNELS.map(m =>
    fader({ name: m.n, pct: m.v, sub: dmx(m.v), w: 80, h: 210, track: 132, tint: C.teal, locked: true })
  ).join('\n      ');

  const rgbCards = RGB_FIXTURES.map(f => {
    const tints = [C.red, C.green, C.blue];
    const names = ['Rot', 'Grün', 'Blau'];
    const inner = `<div style="display:flex;gap:8px;justify-content:center;">
      ${f.v.map((v, i) => fader({ name: `${f.n} ${names[i]}`, pct: v, sub: dmx(v), w: 80, h: 190, track: 116, tint: tints[i] })).join('\n      ')}
    </div>`;
    const on = f.v.some(v => v > 0);
    return card(f.n, on ? `<span style="color:${C.amber};">aktiv</span>` : 'aus', inner, 328, 282);
  }).join('\n    ');

  return `
<div style="width:1280px;height:800px;display:flex;flex-direction:column;background:${C.bg};box-sizing:border-box;overflow:hidden;">
  ${header()}
  <div style="flex-grow:1;padding:16px;display:flex;flex-direction:column;gap:16px;box-sizing:border-box;">

    <div style="display:flex;gap:16px;">
      <div style="width:560px;display:flex;flex-direction:column;gap:16px;">
        ${card('Dimmer', '6 Kanäle · Adr. 1–6', `<div style="display:flex;gap:8px;justify-content:center;">${dimFaders}</div>`, 560, 282)}
        ${card('Moving Light', `${iconLock} vom Live-Pult gesteuert`,
          `<div style="display:flex;gap:8px;justify-content:center;">${mlFaders}</div>`, 560, 282)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(2, minmax(0, 1fr));gap:16px;">
        ${rgbCards}
      </div>
    </div>

    <div style="height:76px;background:${C.panel};border:1px solid ${C.line};border-radius:12px;display:flex;align-items:center;padding:0 16px;gap:16px;box-sizing:border-box;">
      <div style="display:flex;flex-direction:column;gap:2px;">
        <div style="font:600 13px/1.2 ${SANS};color:${C.txt};">8 Kanäle im Programmer</div>
        <div style="font:400 11px/1.2 ${SANS};color:${C.txt3};">Der Programmer liegt über den Presets (HTP) und wird nicht gespeichert.</div>
      </div>
      <div style="flex-grow:1;"></div>
      <div style="min-width:150px;height:48px;padding:0 20px;border-radius:10px;border:1px solid ${C.line2};background:${C.panel2};display:flex;align-items:center;justify-content:center;">
        <div style="font:500 14px/1 ${SANS};color:${C.txt2};">Alles auf 0</div>
      </div>
      <div style="min-width:230px;height:48px;padding:0 20px;border-radius:10px;border:1px solid ${C.amber};background:#2A2013;display:flex;align-items:center;justify-content:center;">
        <div style="font:600 14px/1 ${SANS};color:${C.amber};">Als Preset speichern …</div>
      </div>
    </div>
  </div>
</div>`;
}

/* ---------- Dialoge ---------------------------------------------------- */

function dialogFrame(inner, w, h) {
  return `
<div style="width:${w}px;height:${h}px;background:${C.bg};display:flex;align-items:center;justify-content:center;box-sizing:border-box;padding:24px;">
  <div style="width:100%;background:${C.panel};border:1px solid ${C.line2};border-radius:14px;padding:24px;display:flex;flex-direction:column;gap:20px;box-sizing:border-box;box-shadow:0 24px 60px #0009;">
    ${inner}
  </div>
</div>`;
}

function btn(label, kind = 'ghost', grow = false) {
  const style = {
    ghost:   `border:1px solid ${C.line2};background:${C.panel2};color:${C.txt2};`,
    primary: `border:1px solid ${C.amber};background:#2A2013;color:${C.amber};`,
    danger:  `border:1px solid ${C.red};background:#2A1712;color:${C.red};`
  }[kind];
  return `<div style="${grow ? 'flex-grow:1;' : ''}height:52px;padding:0 22px;border-radius:10px;${style}display:flex;align-items:center;justify-content:center;">
      <div style="font:600 14px/1 ${SANS};">${label}</div>
    </div>`;
}

function dialogPresetOverwrite() {
  return dialogFrame(`
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="font:600 18px/1.3 ${SANS};color:${C.txt};">Platz ist belegt</div>
      <div style="font:400 14px/1.5 ${SANS};color:${C.txt2};">Seite 1, Fader 2 ist bereits mit <span style="color:${C.txt};">„LED Warm“</span> belegt. Überschreiben löscht die dort gespeicherten Kanalwerte.</div>
    </div>
    <div style="background:${C.panel2};border:1px solid ${C.line};border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:8px;">
      <div style="font:400 11px/1 ${MONO};color:${C.txt3};letter-spacing:.08em;">NEUER INHALT</div>
      <div style="font:500 14px/1.4 ${SANS};color:${C.txt};">8 Kanäle aus dem Programmer</div>
      <div style="font:400 12px/1.5 ${MONO};color:${C.txt3};">Dim 3 · Dim 4 · RGB 1 R/G/B · RGB 2 R/G/B</div>
    </div>
    <div style="display:flex;gap:12px;">
      ${btn('Abbrechen', 'ghost', true)}
      ${btn('Anderen Platz wählen', 'ghost', true)}
      ${btn('Überschreiben', 'danger', true)}
    </div>`, 660, 420);
}

function dialogPosition() {
  return dialogFrame(`
    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="font:600 18px/1.3 ${SANS};color:${C.txt};">Position 5</div>
      <div style="font:400 14px/1.5 ${SANS};color:${C.txt2};">Ändert nur Name und Fadezeit. Die gespeicherte Position bleibt unverändert — der Kopf bewegt sich nicht.</div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="font:400 11px/1 ${SANS};color:${C.txt3};letter-spacing:.06em;">NAME</div>
      <div style="height:56px;border:1px solid ${C.line2};background:${C.sunk};border-radius:10px;display:flex;align-items:center;padding:0 16px;">
        <div style="font:500 16px/1 ${SANS};color:${C.txt};">Bar</div>
        <div style="width:2px;height:22px;background:${C.amber};margin-left:2px;"></div>
      </div>
    </div>

    <div style="display:flex;flex-direction:column;gap:8px;">
      <div style="font:400 11px/1 ${SANS};color:${C.txt3};letter-spacing:.06em;">FADEZEIT</div>
      <div style="display:flex;gap:12px;align-items:center;">
        <div style="width:56px;height:56px;border:1px solid ${C.line2};background:${C.panel2};border-radius:10px;display:flex;align-items:center;justify-content:center;font:600 24px/1 ${SANS};color:${C.txt2};">−</div>
        <div style="flex-grow:1;height:56px;border:1px solid ${C.line2};background:${C.sunk};border-radius:10px;display:flex;align-items:center;justify-content:center;gap:6px;">
          <div style="font:600 22px/1 ${MONO};color:${C.txt};">5.5</div>
          <div style="font:400 14px/1 ${SANS};color:${C.txt3};">Sekunden</div>
        </div>
        <div style="width:56px;height:56px;border:1px solid ${C.line2};background:${C.panel2};border-radius:10px;display:flex;align-items:center;justify-content:center;font:600 24px/1 ${SANS};color:${C.txt2};">+</div>
      </div>
    </div>

    <div style="height:1px;background:${C.line};"></div>

    <div style="display:flex;gap:12px;">
      ${btn('Löschen', 'danger')}
      <div style="flex-grow:1;"></div>
      ${btn('Abbrechen', 'ghost')}
      ${btn('Speichern', 'primary')}
    </div>
    <div style="font:400 12px/1.5 ${SANS};color:${C.txt3};">Position neu setzen: auf dem Live-Screen den Button lang drücken.</div>`, 660, 620);
}

/* ---------- Verbindung getrennt ---------------------------------------- */

function disconnectedScreen() {
  return `
<div style="position:relative;width:1280px;height:800px;background:${C.bg};box-sizing:border-box;overflow:hidden;">

  <div style="position:absolute;inset:0;filter:grayscale(0.75) brightness(0.55);">
    ${liveScreen()}
  </div>

  <div style="position:absolute;inset:0;border:4px solid ${C.red};box-sizing:border-box;pointer-events:none;"></div>

  <div style="position:absolute;left:0;right:0;top:0;height:112px;background:#2A1712;border-bottom:2px solid ${C.red};display:flex;align-items:center;padding:0 24px;gap:20px;box-sizing:border-box;">
    <div style="width:20px;height:20px;border-radius:50%;background:${C.red};box-shadow:0 0 0 6px ${C.red}33;"></div>
    <div style="display:flex;flex-direction:column;gap:5px;">
      <div style="font:600 22px/1.2 ${SANS};color:${C.txt};">Verbindung getrennt</div>
      <div style="font:400 14px/1.3 ${SANS};color:#D6A99E;">Angezeigt wird der letzte bekannte Stand von <span style="font-family:${MONO};">14:32:07</span>. Bedienung ist gesperrt — die Anlage läuft unverändert weiter.</div>
    </div>
    <div style="flex-grow:1;"></div>
    <div style="display:flex;align-items:center;gap:10px;padding:0 18px;height:48px;border:1px solid ${C.red};border-radius:10px;">
      <div style="width:10px;height:10px;border-radius:50%;background:${C.red};"></div>
      <div style="font:500 14px/1 ${SANS};color:${C.txt};">Neu verbinden … Versuch 3</div>
    </div>
  </div>
</div>`;
}

/* ---------- Schreiben --------------------------------------------------- */

const files = {
  'Main.dc.html': liveScreen(),
  'LiveAlternative.dc.html': liveAltScreen(),
  'Programmer.dc.html': programmerScreen(),
  'DialogPreset.dc.html': dialogPresetOverwrite(),
  'DialogPosition.dc.html': dialogPosition(),
  'Getrennt.dc.html': disconnectedScreen()
};

for (const [name, body] of Object.entries(files)) {
  writeFileSync(new URL(`./${name}`, import.meta.url), doc(body), 'utf8');
}

const canvas = {
  artboards: [
    { file: 'Main.dc.html',            x: 0,    y: 0,    w: 1280, h: 800 },
    { file: 'LiveAlternative.dc.html', x: 1400, y: 0,    w: 1280, h: 800 },
    { file: 'Programmer.dc.html',      x: 0,    y: 960,  w: 1280, h: 800 },
    { file: 'Getrennt.dc.html',        x: 1400, y: 960,  w: 1280, h: 800 },
    { file: 'DialogPreset.dc.html',    x: 0,    y: 1920, w: 660,  h: 420 },
    { file: 'DialogPosition.dc.html',  x: 760,  y: 1920, w: 660,  h: 620 }
  ],
  annotations: [
    { id: 'note-server', x: 0, y: -190, w: 620,
      text: 'Leitgedanke: der Server hält den Zustand, das Tablet stellt Anträge.\nDeshalb hat jeder Fader einen hellen Strich (= Serverwert), auf dem der Griff sitzt — die Stellung ist nie der lokale Wunsch, sondern das, was die Anlage wirklich tut. Die Kopfzeile zeigt mit "10/s", dass der Zustand laufend nachgeliefert wird.' },
    { id: 'note-layout', x: 1400, y: -190, w: 620,
      text: 'Alternative Anordnung: Pad links, Preset-Bank rechts (2 Reihen à 8).\nIm Betrieb der eigentliche Unterschied — links Dauergriff für den Kopf, rechts der Daumen auf den Presets. Main hat stattdessen die Faderbank unten über die volle Breite, wie an einem echten Pult.' },
    { id: 'note-ml', x: 0, y: 1810, w: 620,
      text: 'Im Programmer sind Pan/Tilt/Zoom/Dimmer des Wash gesperrt dargestellt: das Backend überschreibt diese Kanäle nachgelagert, Fader dort hätten keine Wirkung (Befund B der ANALYSE). Kanäle mit fixed_value tauchen gar nicht erst auf.' },
    { id: 'note-dialog', x: 760, y: 2600, w: 660,
      text: 'Der Positions-Dialog ändert bewusst nur Name und Fadezeit (position.update). Neu setzen bleibt der lange Druck auf dem Live-Screen (position.store), damit Koordinaten weiter ausschließlich aus dem Serverzustand kommen.' }
  ],
  launch: { view: 'canvas' }
};

writeFileSync(new URL('./canvas.json', import.meta.url), JSON.stringify(canvas, null, 2), 'utf8');
console.log('geschrieben:', Object.keys(files).join(', '), '+ canvas.json');
