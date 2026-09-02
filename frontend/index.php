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

// Cache-Buster fuer die Mitbringsel. Apache schickt fuer app.css/app.js keine
// Cache-Header; Chrome haelt sie dann heuristisch tagelang fest - und der
// Service Worker holt sie ueber denselben HTTP-Cache. Ohne das hier kommt nach
// einem Update neues Markup mit altem CSS an. Die Dateizeit im Query aendert
// die URL und beendet das zuverlaessig.
function asset($datei) {
  $zeit = @filemtime(__DIR__ . '/' . $datei);
  return $datei . '?v=' . ($zeit ?: '0');
}
?>
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Atrium Light</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no,viewport-fit=cover">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="apple-mobile-web-app-title" content="Atrium">
  <meta name="application-name" content="Atrium">
  <meta name="theme-color" content="#131211">
  <meta name="color-scheme" content="dark">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="icon" type="image/png" sizes="192x192" href="app-icons/icon-192.png">
  <link rel="apple-touch-icon" href="app-icons/icon-192.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap">
  <link rel="stylesheet" href="<?php echo asset('app.css'); ?>">
</head>
<body>

<div id="fit">
<div id="app">

  <!-- Kopfzeile: Verbindung, Zustandsquelle, Grandmaster, Blackout -->
  <div id="header">
    <div id="conn">
      <div id="conn-dot"></div>
      <div id="conn-label">Verbinde …</div>
    </div>

    <div class="hdr-sep"></div>

    <div id="gamepad">
      <div class="cap">Controller</div>
      <div class="row">
        <div id="gp-dot"></div>
        <div id="gp-label">nicht verbunden</div>
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

    <!-- Schieben statt Druecken: der Griff muss ueber die ganze Bahn
         gezogen werden, damit nichts versehentlich schwarz wird. -->
    <div id="blackout">
      <div id="bo-text">BLACKOUT ▸</div>
      <div id="bo-knob">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M13 2 4 14h7l-1 8 9-12h-7z"></path></svg>
      </div>
    </div>
  </div>

  <main>

    <!-- ---------------- Live ---------------- -->
    <div class="page active" id="page-live">

      <div id="live-row">

        <div class="col" style="width:386px;">
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

        <div class="col" style="flex:1 1 0;">
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
          <div class="r">16 Plätze · lang drücken: leerer Platz belegen, Name bearbeiten</div>
        </div>
        <div id="presetbank"></div>
      </div>

    </div>

    <!-- ---------------- Programmer ---------------- -->
    <div class="page" id="page-programmer">

      <!-- Erst die Lampen waehlen, dann die Attribute setzen. -->
      <div id="prog-pick">
        <div class="sect-title">
          <div class="t">Lampen</div>
          <div class="r">
            <span id="prog-pick-hint">tippen = auswählen · mehrere möglich</span>
            <span class="mini" id="prog-all">Alle</span>
            <span class="mini" id="prog-none">Keine</span>
          </div>
        </div>
        <div id="prog-fixtures"></div>
      </div>

      <div id="prog-attrs">
        <div class="sect-title">
          <div class="t">Attribute</div>
          <div class="r" id="prog-attr-sub">keine Auswahl</div>
        </div>
        <div id="prog-attr-body"></div>
      </div>

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

</div><!-- /#app -->
</div><!-- /#fit -->

<script>
  window.LIGHT_CFG = {
    host: "<?php echo htmlspecialchars($wsHost, ENT_QUOTES); ?>",
    port: "<?php echo htmlspecialchars($wsPort, ENT_QUOTES); ?>"
  };
</script>
<script src="<?php echo asset('app.js'); ?>"></script>

<script>
  // Service Worker: macht das Pult auf dem Tablet installierbar und faengt
  // kurze Netz-Aussetzer ab. Braucht einen sicheren Kontext, laeuft also nur
  // ueber https oder auf localhost. Im LAN ueber http bleibt die Seite eine
  // ganz normale Webseite - das ist kein Fehler, nur kein App-Modus.
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
    // Nach einem Update den neuen Worker uebernehmen: einmal neu laden, aber
    // nur wenn vorher schon einer aktiv war (sonst laedt die Erstinstallation
    // die Seite grundlos neu).
    const hatteWorker = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hatteWorker || window.__lightReloading) return;
      window.__lightReloading = true;
      location.reload();
    });
  }
</script>

</body>
</html>
