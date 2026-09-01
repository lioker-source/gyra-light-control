<?php
// WebSocket-Host, in dieser Reihenfolge:
//   1. Umgebungsvariable LIGHT_WS_HOST (docker-compose / Apache SetEnv)
//   2. leer  -> das JS nimmt den Host aus der Browser-Adresszeile.
//      Das ist der Normalfall und funktioniert sowohl fuer localhost
//      als auch fuer den Zugriff vom Tablet ueber die LAN-IP.
//   3. Zur Laufzeit ueberschreibbar mit ?ws=<host>[:<port>]
$wsHost = getenv('LIGHT_WS_HOST') ?: '';
$wsPort = getenv('LIGHT_WS_PORT') ?: '8080';

// Nicht zwischenspeichern: die Seite traegt die WS-Adresse in sich.
// Ein Tablet mit alter Kopie wuerde sonst stumm den falschen Port ansprechen.
header('Cache-Control: no-store, must-revalidate');
header('Pragma: no-cache');
?>
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Atrium Light</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="app.css">
</head>
<body>

<div id="app">

  <!-- Kopfzeile: Verbindung, Zustandsquelle, Grandmaster, Blackout -->
  <div id="header">
    <div id="conn">
      <div id="conn-dot"></div>
      <div>
        <div id="conn-label">Verbinde …</div>
        <div id="conn-sub">atrium-light · Universe 0</div>
      </div>
    </div>

    <div class="hdr-sep"></div>

    <div id="statecount">
      <div class="cap">Zustand vom Server</div>
      <div class="row">
        <div id="state-hz">10/s</div>
        <div id="state-sub">laufend aufgefrischt</div>
      </div>
    </div>

    <div class="hdr-sep"></div>

    <div id="tabs">
      <div class="tab active" data-page="live">Live</div>
      <div class="tab" data-page="programmer">Programmer</div>
      <div class="tab" data-page="patch">Patch</div>
    </div>

    <div class="spacer"></div>

    <div id="gm-wrap">
      <div class="cap">Grandmaster</div>
      <div class="hfader" id="gm">
        <div class="fill"></div>
        <div class="mark"></div>
        <div class="grip"></div>
      </div>
      <div id="gm-val">100%</div>
    </div>

    <div class="hdr-sep"></div>

    <div id="blackout">
      <div class="lbl">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"></path></svg>
        <span>BLACKOUT</span>
      </div>
      <div class="hint" id="blackout-hint">2 s halten</div>
      <div class="hold" id="blackout-hold"></div>
    </div>
  </div>

  <main>

    <!-- ---------------- Live ---------------- -->
    <div class="page active" id="page-live">

      <div id="live-row">

        <div class="col" style="width:360px;">
          <div class="sect-title"><div class="t">Moving Light</div><div class="r">Ist-Position</div></div>
          <div id="pad">
            <div class="grid-h" style="top:25%"></div>
            <div class="grid-h" style="top:50%"></div>
            <div class="grid-h" style="top:75%"></div>
            <div class="grid-v" style="left:25%"></div>
            <div class="grid-v" style="left:50%"></div>
            <div class="grid-v" style="left:75%"></div>
            <div id="pad-dot" style="left:50%;top:50%"></div>
            <div id="pad-fade"><i></i><span>FAHRT LÄUFT</span></div>
            <div class="axis pan">PAN</div>
            <div class="axis tilt">TILT</div>
          </div>
        </div>

        <div class="col" style="width:232px;">
          <div class="sect-title"><div class="t">Wash</div><div class="r">live</div></div>
          <div id="wash-faders" style="display:flex;gap:8px;"></div>
        </div>

        <div class="col" style="width:624px;">
          <div class="sect-title">
            <div class="t">Positionen</div>
            <div class="r">tippen = anfahren · halten = speichern</div>
          </div>
          <div id="positions"></div>
        </div>

      </div>

      <div class="col">
        <div class="sect-title">
          <div class="t">Presets</div>
          <div class="r">16 Plätze · lang drücken zum Speichern</div>
        </div>
        <div id="presetbank"></div>
      </div>

    </div>

    <!-- ---------------- Programmer ---------------- -->
    <div class="page" id="page-programmer">
      <div id="prog-row"></div>
      <div id="prog-bar">
        <div>
          <div class="t" id="prog-count">0 Kanäle im Programmer</div>
          <div class="s">Der Programmer liegt über den Presets (HTP) und wird nicht gespeichert.</div>
        </div>
        <div class="spacer"></div>
        <div class="btn" id="prog-clear">Alles auf 0</div>
        <div class="btn primary" id="prog-save" style="min-width:230px;">Als Preset speichern …</div>
      </div>
    </div>

    <!-- ---------------- Patch ---------------- -->
    <div class="page" id="page-patch">
      <div class="sect-title">
        <div class="t">Patch</div>
        <div class="r">Adresse ändern behält Presets · Bauart ändern nicht</div>
      </div>
      <div id="patch-list"></div>
      <div id="patch-bar">
        <div>
          <div class="t" id="patch-count">0 Fixtures</div>
          <div class="s" id="patch-warn">&nbsp;</div>
        </div>
        <div class="spacer"></div>
        <div class="btn primary" id="patch-add" style="min-width:200px;">Fixture hinzufügen …</div>
      </div>
    </div>

  </main>
</div>

<!-- Verbindung getrennt: der letzte Stand bleibt sichtbar -->
<div id="offline">
  <div class="frame"></div>
  <div class="band">
    <div class="dot"></div>
    <div>
      <h3>Verbindung getrennt</h3>
      <div class="sub">Angezeigt wird der letzte bekannte Stand von <b id="offline-time">–</b>. Bedienung ist gesperrt — die Anlage läuft unverändert weiter.</div>
    </div>
    <div class="spacer"></div>
    <div class="try"><i></i><span id="offline-try">Neu verbinden …</span></div>
  </div>
</div>

<div id="modal"></div>
<div id="toast"></div>

<script>
  window.LIGHT_CFG = {
    host: "<?php echo htmlspecialchars($wsHost, ENT_QUOTES); ?>",
    port: "<?php echo htmlspecialchars($wsPort, ENT_QUOTES); ?>"
  };
</script>
<script src="app.js"></script>

</body>
</html>
