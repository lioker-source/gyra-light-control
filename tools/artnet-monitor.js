#!/usr/bin/env node
'use strict';

/**
 * Art-Net-Monitor – Ersatz für echte DMX-Hardware beim Entwickeln.
 *
 * Lauscht auf UDP 6454, dekodiert ArtDMX-Pakete und zeigt die Kanalwerte
 * unter http://localhost:8082 als live aktualisierte Tabelle an.
 *
 * Ohne Abhängigkeiten – läuft mit blankem Node.
 *
 *   node tools/artnet-monitor.js
 */

const dgram = require('dgram');
const http = require('http');

const ART_PORT  = Number(process.env.ART_PORT || 6454);
const HTTP_PORT = Number(process.env.HTTP_PORT || 8082);

// universe -> { data: Uint8Array(512), packets, lastSeen, from }
const universes = new Map();
let totalPackets = 0;

function parseArtDmx(buf) {
  if (buf.length < 18) return null;
  if (buf.toString('ascii', 0, 7) !== 'Art-Net') return null;
  // OpCode ArtDMX = 0x5000, little endian
  if (buf[8] !== 0x00 || buf[9] !== 0x50) return null;

  const universe = buf[14] | (buf[15] << 8);
  const length = (buf[16] << 8) | buf[17];
  const data = buf.subarray(18, 18 + Math.min(length, 512));
  return { universe, data };
}

const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });

sock.on('error', (err) => {
  console.error('[MONITOR] Socket-Fehler:', err);
});

sock.on('message', (buf, rinfo) => {
  const pkt = parseArtDmx(buf);
  if (!pkt) return;

  let entry = universes.get(pkt.universe);
  if (!entry) {
    entry = { data: new Uint8Array(512), packets: 0, lastSeen: 0, from: '' };
    universes.set(pkt.universe, entry);
    console.log(`[MONITOR] Neues Universe ${pkt.universe} von ${rinfo.address}`);
  }

  entry.data.set(pkt.data, 0);
  entry.packets++;
  entry.lastSeen = Date.now();
  entry.from = `${rinfo.address}:${rinfo.port}`;
  totalPackets++;
});

sock.bind(ART_PORT, () => {
  console.log(`[MONITOR] Art-Net-Empfang auf UDP ${ART_PORT}`);
});

function snapshot() {
  const out = [];
  for (const [uni, e] of universes) {
    out.push({
      universe: uni,
      from: e.from,
      packets: e.packets,
      ageMs: Date.now() - e.lastSeen,
      // nur belegte Kanäle übertragen, sonst 512 Nullen pro Poll
      channels: Array.from(e.data).map((v, i) => [i + 1, v]).filter(([, v]) => v > 0)
    });
  }
  return { totalPackets, universes: out.sort((a, b) => a.universe - b.universe) };
}

const PAGE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<title>Art-Net Monitor</title>
<style>
  body { font: 14px/1.5 system-ui, sans-serif; background:#111; color:#eee; margin:0; padding:1.5rem; }
  h1 { font-size:1.1rem; margin:0 0 .25rem; }
  .sub { color:#888; font-size:.85rem; margin-bottom:1.5rem; }
  .uni { margin-bottom:2rem; }
  .uni h2 { font-size:.9rem; color:#4dd0e1; margin:0 0 .5rem; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(84px,1fr)); gap:4px; }
  .ch { background:#1c1c1c; border:1px solid #333; border-radius:5px; padding:5px 7px; }
  .ch .a { color:#777; font-size:.7rem; }
  .ch .v { font-size:1.05rem; font-variant-numeric:tabular-nums; }
  .bar { height:3px; background:#4dd0e1; border-radius:2px; margin-top:3px; }
  .idle { color:#e57373; }
  .empty { color:#666; font-style:italic; }
</style></head><body>
<h1>Art-Net Monitor</h1>
<div class="sub" id="sub">warte auf Pakete …</div>
<div id="out"></div>
<script>
async function tick() {
  try {
    const r = await fetch('/api/state');
    const s = await r.json();
    document.getElementById('sub').textContent =
      s.totalPackets + ' Pakete empfangen · ' + s.universes.length + ' Universe(s)';
    document.getElementById('out').innerHTML = s.universes.length
      ? s.universes.map(u => {
          const stale = u.ageMs > 2000;
          const head = 'Universe ' + u.universe + ' · von ' + u.from + ' · ' + u.packets +
            ' Pakete' + (stale ? ' <span class="idle">(seit ' + (u.ageMs/1000).toFixed(1) + 's still)</span>' : '');
          const body = u.channels.length
            ? '<div class="grid">' + u.channels.map(([a, v]) =>
                '<div class="ch"><div class="a">Ch ' + a + '</div><div class="v">' + v +
                '</div><div class="bar" style="width:' + (v/255*100).toFixed(0) + '%"></div></div>').join('') + '</div>'
            : '<div class="empty">alle Kanäle auf 0</div>';
          return '<div class="uni"><h2>' + head + '</h2>' + body + '</div>';
        }).join('')
      : '<div class="empty">Noch keine ArtDMX-Pakete empfangen.</div>';
  } catch (e) { /* Server evtl. neu gestartet */ }
}
tick();
setInterval(tick, 250);
</script></body></html>`;

http.createServer((req, res) => {
  if (req.url === '/api/state') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snapshot()));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(PAGE);
}).listen(HTTP_PORT, () => {
  console.log(`[MONITOR] Weboberfläche auf http://localhost:${HTTP_PORT}`);
});
