<?php
// WebSocket-Host, in dieser Reihenfolge:
//   1. Umgebungsvariable LIGHT_WS_HOST (docker-compose / Apache SetEnv)
//   2. leer  -> das JS nimmt den Host aus der Browser-Adresszeile.
//      Das ist der Normalfall und funktioniert sowohl fuer localhost
//      als auch fuer den Zugriff vom Tablet ueber die LAN-IP.
//   3. Zur Laufzeit ueberschreibbar mit ?ws=<host>[:<port>]
$wsHost = getenv('LIGHT_WS_HOST') ?: '';
$wsPort = getenv('LIGHT_WS_PORT') ?: '8080';
?>
<!doctype html>
<html lang="de">
<head>
  <meta charset="utf-8">
  <title>Atrium Light Control – Movinglight</title>
  <meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">

  <!-- w3.css Basis -->
  <link rel="stylesheet" href="https://www.w3schools.com/w3css/4/w3.css">

  <style>
    * { box-sizing: border-box; }

    body {
      margin: 0;
      font-family: system-ui, -apple-system, sans-serif;
      background: #111;
      color: #eee;
      display: flex;
      flex-direction: column;
    }

    header h1 {
      font-size: 1.2rem;
      margin: 0;
    }

    /* Status & Debug komplett ausblenden */
    #status,
    #ws-debug,
    #values {
      display: none !important;
    }

    /* Tabs */
    #tabbar {
      display: flex;
      gap: 0.5rem;
      margin-top: 0.5rem;
    }
    #tabbar .tab {
      flex: 0 0 auto;
      font-size: 0.85rem;
      border-radius: 999px;
      cursor: pointer;
      border: 1px solid #444;
    }
    #tabbar .tab:not(.w3-teal) {
      background: #1a1a1a;
      color: #ddd;
    }

    main {
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }

    /******************************************
     * Live-Page Layout
     ******************************************/
    #page-live {
      width: 100%;
      max-width: 1200px;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
    }

    #live-layout {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.75rem;
      margin-top: 0.5rem;
    }

    #live-left,
    #live-right {
      width: 100%;
    }

    /* Presets links */
    #presets {
      width: 100%;
      display: flex;
      flex-direction: column;
      gap: 0.25rem;
    }
    #presets-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      font-size: 0.85rem;
      color: #ccc;
    }
    #preset-faders {
      display: flex;
      gap: 0.5rem;
      overflow-x: auto;
      padding: 0.25rem 0;
    }

    /* Pad + Sensitivity + Zoom/Dimmer rechts */
    #pad-and-sensitivity {
      display: flex;
      flex-direction: row;
      align-items: stretch;
      gap: 0.5rem;
    }

    #sensitivity-column {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
    }
    #sensitivity-label {
      font-size: 0.75rem;
      margin-bottom: 0.25rem;
      text-align: center;
    }
    #sensitivity-fader {
      display: flex;
      justify-content: center;
      align-items: center;
    }

    /* NEU: Zoom/Dimmer-Fader-Container rechts vom Pad */
    #zoom-dimmer {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 0.75rem;
    }

    /* Pad */
    #pad-wrapper {
      width: 100%;
      max-width: 600px;
      aspect-ratio: 1 / 1;
    }
    #pad {
      width: 100%;
      height: 100%;
      border-radius: 16px;
      border: 2px solid #555;
      background: radial-gradient(circle at center, #222 0, #111 60%);
      position: relative;
      overflow: hidden;
      touch-action: none;
    }
    #pad::before,
    #pad::after {
      content: "";
      position: absolute;
      left: 50%;
      top: 50%;
      transform: translate(-50%, -50%);
      background: #444;
    }
    #pad::before {
      width: 2px;
      height: 100%;
    }
    #pad::after {
      width: 100%;
      height: 2px;
    }
    #dot {
      position: absolute;
      width: 20px;
      height: 20px;
      margin-left: -10px;
      margin-top: -10px;
      border-radius: 50%;
      border: 2px solid #0ff;
      background: rgba(0,255,255,0.25);
      pointer-events: none;
      left: 50%;
      top: 50%;
    }

    /* Positions-Buttons unter dem Pad */
    #position-buttons {
      margin-top: 0.5rem;
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 0.5rem;
    }
    .pos-btn {
      padding: 0.6rem 0.4rem;
      font-size: 1rem;
      font-weight: 600;
    }

    /******************************************
     * Fader-Styles (Preset + Programmer + Sensitivity + Zoom/Dimmer)
     ******************************************/
    .fader {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: flex-start;

      width: var(--fader-width);
      height: var(--fader-height);
      padding: 6px;
      border-radius: 10px;
      background: #181818;
      border: 1px solid #333;
      flex: 0 0 auto;

      /* Auf der Fader-Karte horizontales Wischen zum Scrollen erlauben. */
      touch-action: pan-x;
    }

    .fader-track {
      position: relative;
      width: calc(var(--fader-width) * 0.45);
      height: var(--fader-track-height);
      border-radius: 999px;
      background: linear-gradient(to top, #222, #444);
      border: 1px solid #111;
      box-shadow: inset 0 0 4px rgba(0,0,0,0.8);
      margin-bottom: 8px;

      /* Direkt auf dem Track gehört die Geste dem Fader. */
      touch-action: none;
    }

    .fader-thumb {
      position: absolute;
      left: 50%;
      transform: translateX(-50%);
      width: var(--fader-thumb-size);
      height: var(--fader-thumb-size);
      border-radius: 50%;
      background: #f4f4f4;
      border: 2px solid #111;
      box-shadow: 0 0 6px rgba(0,0,0,0.7);
      touch-action: none;
    }
	
	.sensitivity {
		background: #32a4a8;
	}
	
	.dimmer {
		background: #f2d307;
	}
	
	.zoom {
		background: #b48dd6;
	}

    .fader.active .fader-thumb {
      box-shadow: 0 0 10px rgba(0,255,255,0.8);
    }
    .fader-name {
      font-size: 0.75rem;
      text-align: center;
      line-height: 1.2;
      margin-bottom: 0.1rem;
    }
    .fader-meta {
      font-size: 0.65rem;
      color: #888;
      text-align: center;
    }

    /* Programmer-Page */
    #page-programmer {
      width: 100%;
      max-width: 900px;
      display: none;
      flex-direction: column;
      gap: 0.5rem;
      margin: 0 auto;
    }

    #programmer-info {
      font-size: 0.8rem;
      color: #ccc;
      width: 100%;
    }
    #programmer-faders {
      width: 100%;
      display: flex;
      flex-wrap: nowrap;
      overflow-x: auto;
      overflow-y: hidden;
      gap: 0.5rem;
      padding: 0.25rem 0;

      /* iPad/Safari: horizontales Wischen als Scroll-Geste zulassen. */
      touch-action: pan-x;
      -webkit-overflow-scrolling: touch;
    }

    /* Name-Zeile für Presets (zentral) */
    #programmer-name-row {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 0.5rem;
      font-size: 0.85rem;
    }
    #programmer-preset-name {
      flex: 1;
      padding: 0.4rem 0.6rem;
      border-radius: 6px;
      border: 1px solid #444;
      background: #222;
      color: #eee;
    }
    #programmer-preset-name::placeholder {
      color: #666;
    }

    #programmer-save-buttons {
      display: flex;
      flex-wrap: wrap;
      gap: 0.4rem;
      width: 100%;
    }
    .save-button {
      flex: 0 0 calc(25% - 0.4rem);
      min-width: 120px;
      padding: 0.4rem 0.5rem;
      font-size: 0.8rem;
      border-radius: 8px;
      border: 1px solid #555;
      background: #222;
      color: #eee;
      cursor: pointer;
    }
    .save-button:hover {
      background: #2a2a2a;
    }

    .ml-pos-btn-saving {
      animation: ml-pos-save-flash 0.6s ease-out;
    }

    @keyframes ml-pos-save-flash {
      0% {
        box-shadow: 0 0 0 0 rgba(0,150,136,0.0); /* w3-teal */
        transform: scale(1);
      }
      40% {
        box-shadow: 0 0 12px 4px rgba(0,150,136,0.9);
        transform: scale(1.04);
      }
      100% {
        box-shadow: 0 0 0 0 rgba(0,150,136,0.0);
        transform: scale(1);
      }
    }

    /******************************************
     * Responsive / Orientation
     ******************************************/
    @media (orientation: landscape) {
      #page-live {
        align-items: stretch;
      }
      #live-layout {
        flex-direction: row;
        align-items: stretch;
      }
      #live-left {
        flex: 1;
      }
      #live-right {
        flex: 1.2;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }
      #pad-wrapper {
        max-width: none;
        height: 50vh;     /* ~50% der Höhe, wie gewünscht */
        aspect-ratio: auto;
      }
    }

    @media (orientation: portrait) {
      #pad-wrapper {
        width: 100%;
        max-width: 600px;
        aspect-ratio: 1 / 1;
        margin: 0 auto;
      }
    }
  </style>
</head>
<body class="w3-dark-grey">
  <header class="w3-container w3-teal">
    <h1>Atrium Light Control – Movinglight</h1>
  </header>

  <div class="w3-container" style="padding-bottom: 1rem;">
    <div id="status" class="w3-small">Verbinde zum WebSocket-Server …</div>
    <pre id="ws-debug"></pre>

    <div id="tabbar">
      <button class="tab w3-button w3-round-large w3-teal active" data-page="live">Live</button>
      <button class="tab w3-button w3-round-large" data-page="programmer">Programmer</button>
    </div>

    <main>
      <!-- LIVE-PAGE -->
      <section id="page-live">
        <div id="live-layout">
          <!-- Links: Presets -->
          <div id="live-left">
            <section id="presets">
              <div id="presets-header">
                <span>Presets</span>
                <span id="presets-page-info"></span>
              </div>
              <div id="preset-faders"></div>
            </section>
          </div>

          <!-- Rechts: Sensitivity + Pad + Zoom/Dimmer-Fader + 9 Positions-Buttons -->
          <div id="live-right">
            <div id="pad-and-sensitivity">
              <div id="sensitivity-column">
                <div id="sensitivity-label">Pad-Sensitivität</div>
                <div id="sensitivity-fader"></div>
              </div>
              <div id="pad-wrapper">
                <div id="pad">
                  <div id="dot"></div>
                </div>
              </div>
              <!-- NEU: Zoom/Dimmer-Fader -->
              <div id="zoom-dimmer">
                <!-- JS füllt hier zwei Fader: Zoom + Dimmer -->
              </div>
            </div>

            <div id="position-buttons"></div>
          </div>
        </div>
      </section>

      <!-- PROGRAMMER-PAGE -->
      <section id="page-programmer">
        <div id="programmer-info">
          Programmer: Hier stellst du die einzelnen DMX-Kanäle ein.
          Mit den Buttons unten speicherst du die aktuelle Szene auf Preset-Slots (1–16).
        </div>

        <!-- zentraler Name für alle Presets -->
        <div id="programmer-name-row">
          <span>Preset-Name:</span>
          <input id="programmer-preset-name" type="text" placeholder="z.B. Warmfront Bühne links">
        </div>

        <div id="programmer-faders"></div>
        <div id="programmer-save-buttons"></div>
      </section>
    </main>
  </div>

  <script>
    /*************************************************
     * WebSocket-Verbindung
     *************************************************/
    const WS_HOST_CONFIGURED = "<?php echo htmlspecialchars($wsHost, ENT_QUOTES); ?>";
    const WS_PORT_CONFIGURED = "<?php echo htmlspecialchars($wsPort, ENT_QUOTES); ?>";

    // Reihenfolge: ?ws=host[:port]  >  serverseitige Konfiguration  >  aktueller Host
    function resolveWsUrl() {
      const override = new URLSearchParams(location.search).get('ws');
      if (override) {
        return override.includes(':')
          ? `ws://${override}`
          : `ws://${override}:${WS_PORT_CONFIGURED}`;
      }
      const host = WS_HOST_CONFIGURED || location.hostname || '127.0.0.1';
      return `ws://${host}:${WS_PORT_CONFIGURED}`;
    }

    const wsUrl = resolveWsUrl();

    const statusEl        = document.getElementById('status');
    const wsDebugEl       = document.getElementById('ws-debug');
    const presetContainer = document.getElementById('preset-faders');
    const presetsPageInfo = document.getElementById('presets-page-info');

    const pageLive       = document.getElementById('page-live');
    const pageProgrammer = document.getElementById('page-programmer');
    const tabButtons     = document.querySelectorAll('#tabbar .tab');

    const programmerContainer       = document.getElementById('programmer-faders');
    const programmerSaveButtonsEl   = document.getElementById('programmer-save-buttons');
    const programmerPresetNameInput = document.getElementById('programmer-preset-name');

    const positionButtonsContainer  = document.getElementById('position-buttons');
    const sensitivityFaderHost      = document.getElementById('sensitivity-fader');
    const zoomDimmerContainer       = document.getElementById('zoom-dimmer');

    const FADER_WIDTH_PX       = 80;   // Gesamtbreite pro Fader
    const FADER_HEIGHT_PX      = 350;  // Gesamthöhe pro Fader
    const FADER_TRACK_HEIGHT_PX= 280;  // Höhe des eigentlichen Tracks
    const FADER_THUMB_SIZE_PX  = 44;   // Durchmesser des Thumb/Handles

    // CSS-Variablen setzen (einmalig)
    document.documentElement.style.setProperty('--fader-width',        `${FADER_WIDTH_PX}px`);
    document.documentElement.style.setProperty('--fader-height',       `${FADER_HEIGHT_PX}px`);
    document.documentElement.style.setProperty('--fader-track-height', `${FADER_TRACK_HEIGHT_PX}px`);
    document.documentElement.style.setProperty('--fader-thumb-size',   `${FADER_THUMB_SIZE_PX}px`);

    let ws;
    let wsConnected = false;

    // letzte Preset-Meta aus init_state merken (für Save-Slots)
    let presetsFromServer = [];
    // Kanäle für Programmer
    let channelsFromServer = [];

    // Sensitivity (Geschwindigkeitsskala für Pan/Tilt)
    // 1.0 = -1..+1, 0.1 = -0.1..+0.1
    let padSpeedScale = 1.0;
    let sensitivityFaderState = null; // { value, wrapper, track, thumb, pointerId }

    // NEU: Zoom/Dimmer-Fader-State
    let zoomFaderState   = null;
    let dimmerFaderState = null;

    function connectWebSocket() {
      if (statusEl) statusEl.textContent = `Verbinde mit ${wsUrl} …`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        wsConnected = true;
        if (statusEl) statusEl.textContent = `WebSocket verbunden: ${wsUrl}`;
      };

      ws.onmessage = (ev) => {
        if (wsDebugEl) wsDebugEl.textContent = ev.data.slice(0, 300);

        let msg;
        try {
          msg = JSON.parse(ev.data);
        } catch {
          return;
        }
        if (!msg || !msg.type) return;

        const isInitType = ['init_state', 'init', 'hello'].includes(msg.type);

        // Presets
        let presetsArr = null;
        if (Array.isArray(msg.presets)) {
          presetsArr = msg.presets;
        } else if (Array.isArray(msg.preset_faders)) {
          presetsArr = msg.preset_faders;
        }
        if (isInitType && presetsArr) {
          presetsFromServer = presetsArr.slice();
          buildPresetFaders(presetsArr);
        }

        // Programmer-Kanäle
        if (isInitType && Array.isArray(msg.channels)) {
          channelsFromServer = msg.channels.slice();
          buildProgrammerFaders(channelsFromServer);
        }

        // Pad-Sensitivität aus DB (optional)
        if (isInitType) {
          let s = 1.0;
          if (typeof msg.pad_sensitivity === 'number') {
            s = msg.pad_sensitivity;
          }
          setPadSpeedScaleFromServer(s);

          // Optional: ML-State initial übernehmen (falls gesendet)
          if (msg.ml_state) {
            if (typeof msg.ml_state.zoom === 'number') {
              zoom = clamp(msg.ml_state.zoom, 0, 1);
            }
            if (typeof msg.ml_state.dimmer === 'number') {
              dimmer = clamp(msg.ml_state.dimmer, 0, 1);
            }
            syncZoomDimmerFadersFromValues();
          }
        }
		
		  if (msg.type === 'ml_position_recalled' && msg.ml_state) {
			const s = msg.ml_state;

			if (typeof s.pan === 'number') {
			  pan = clamp(s.pan, 0, 1);
			}
			if (typeof s.tilt === 'number') {
			  tilt = clamp(s.tilt, 0, 1);
			}
			if (typeof s.zoom === 'number') {
			  zoom = clamp(s.zoom, 0, 1);
			}
			if (typeof s.dimmer === 'number') {
			  dimmer = clamp(s.dimmer, 0, 1);
			}

			// Optik aktualisieren
			updateDot();
			updateTexts();

			console.log('recalled' + zoom);

			// Falls du Zoom/Dimmer-Fader-States hast, hier synchronisieren:
			syncZoomDimmerFadersFromState();
		  }
      };

      ws.onerror = (err) => {
        console.error("WebSocket Fehler:", err);
        if (statusEl) statusEl.textContent = `WebSocket-Fehler – siehe Konsole.`;
      };

      ws.onclose = () => {
        wsConnected = false;
        if (statusEl) statusEl.textContent = `WebSocket getrennt. Versuche erneut …`;
        setTimeout(connectWebSocket, 2000);
      };
    }

    connectWebSocket();

    /*************************************************
     * Tabs: Live / Programmer
     *************************************************/
    function showPage(page) {
      if (page === 'live') {
        pageLive.style.display = 'block';
        pageProgrammer.style.display = 'none';
      } else {
        pageLive.style.display = 'none';
        pageProgrammer.style.display = 'flex';
      }
      tabButtons.forEach(btn => {
        const active = btn.dataset.page === page;
        btn.classList.toggle('active', active);
        btn.classList.toggle('w3-teal', active);
      });
    }

    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const page = btn.dataset.page;
        showPage(page);
      });
    });

    /*************************************************
     * Gemeinsame Steuerwerte (0..1)
     *************************************************/
    let pan   = 0.5;
    let tilt  = 0.5;
    let zoom  = 0.5;
    let dimmer = 1.0;

    const pad  = document.getElementById('pad');
    const dot  = document.getElementById('dot');
    const valuesEl = document.getElementById('values'); // existiert, wird aber nicht angezeigt

    /*************************************************
     * HTP-Quellen: Touch & Gamepad (Pan/Tilt)
     *************************************************/
    let panTouchOffset  = 0;  // -1..+1
    let tiltTouchOffset = 0;
    let panCtrlOffset   = 0;
    let tiltCtrlOffset  = 0;

    const TOUCH_TILT_FACTOR   = -1;
    const GAMEPAD_TILT_FACTOR = -1;

    function clamp(v, min, max) {
      return Math.min(max, Math.max(min, v));
    }

    function updateDot() {
      const rect = pad.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      const x = cx + (pan - 0.5) * rect.width;
      const y = cy + (0.5 - tilt) * rect.height;

      dot.style.left = `${x}px`;
      dot.style.top  = `${y}px`;
    }

    function updateTexts() {
      if (!valuesEl) return;
      valuesEl.textContent =
        `Pan:    ${pan.toFixed(2)} (0..1)\n` +
        `Tilt:   ${tilt.toFixed(2)} (0..1)\n` +
        `Zoom:   ${zoom.toFixed(2)} (0..1)\n` +
        `Dimmer: ${(dimmer * 100).toFixed(0)} %`;
    }

    /*************************************************
     * WS-Senden (throttled)
     *************************************************/
    let lastSendTs = 0;
    const SEND_INTERVAL_MS = 50;

    function sendStateToServer() {
      const now = performance.now();
      if (now - lastSendTs < SEND_INTERVAL_MS) return;
      lastSendTs = now;

      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;

      const basePanSpeed  = (pan  - 0.5) * 2;
      const baseTiltSpeed = (tilt - 0.5) * 2;

      const panSpeed  = basePanSpeed  * padSpeedScale;
      const tiltSpeed = baseTiltSpeed * padSpeedScale;

      const msg = {
        type: 'ml_live',
        mode: 'velocity',
        pan_speed:  panSpeed,
        tilt_speed: tiltSpeed,
        zoom,
        dimmer
      };

      ws.send(JSON.stringify(msg));
    }

    function sendPresetFader(presetId, value) {
      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'preset_fader',
        preset_id: presetId,
        value: clamp(value, 0, 1)
      }));
    }

    function sendProgrammerChannel(channelId, value) {
      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'programmer_channel',
        channel_id: channelId,
        value: clamp(value, 0, 1)
      }));
    }

    function sendPadSensitivityToServer() {
      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({
        type: 'ml_sensitivity',
        value: padSpeedScale   // 0.1 .. 1.0
      }));
    }

    /*************************************************
     * Pan/Tilt aus beiden Quellen kombinieren
     *************************************************/
    function updatePanTiltFromSources() {
      function combineAxis(touch, ctrl) {
        if (Math.abs(touch) >= Math.abs(ctrl)) return touch;
        return ctrl;
      }

      const combinedX = combineAxis(panTouchOffset,  panCtrlOffset);
      const combinedY = combineAxis(tiltTouchOffset, tiltCtrlOffset);

      pan  = clamp(0.5 + combinedX / 2, 0, 1);
      tilt = clamp(0.5 + combinedY / 2, 0, 1);

      updateDot();
      updateTexts();
      sendStateToServer();
    }

    /*************************************************
     * Touch-Logik (Joystick + 2-Finger für Zoom/Dimmer)
     *************************************************/
    const JOYSTICK_ACTIVATION_DIST = 20;
    const DOT_GRAB_RADIUS          = 30;

    let joystickTouchId = null;
    let pendingJoystick = false;
    let pendingStartX   = 0;
    let pendingStartY   = 0;

    let twoFingerMode = 'none'; // 'none' | 'unknown' | 'pinch' | 'dimmer'
    let twoFingerIds = [];
    let pinchStartDist = 0;
    let pinchStartZoom = zoom;
    let twoStartAvgY = 0;
    let twoStartDimmer = dimmer;

    const PINCH_DIST_THRESHOLD = 15;
    const DIMMER_Y_THRESHOLD   = 15;

    function getLocalPos(touch, element) {
      const rect = element.getBoundingClientRect();
      return {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top,
        rect
      };
    }

    function dotCenterInLocal() {
      const rect = pad.getBoundingClientRect();
      const cx = rect.width / 2 + (pan - 0.5) * rect.width;
      const cy = rect.height / 2 + (0.5 - tilt) * rect.height;
      return { x: cx, y: cy, rect };
    }

    function handleJoystickMoveTouch(touch) {
      const { x, y, rect } = getLocalPos(touch, pad);
      const cx = rect.width / 2;
      const cy = rect.height / 2;

      let dxNorm = (x - cx) / (rect.width / 2);
      let dyNorm = (y - cy) / (rect.height / 2);

      dxNorm = clamp(dxNorm, -1, 1);
      dyNorm = clamp(dyNorm, -1, 1);

      panTouchOffset = dxNorm;

      const dyAdjusted = dyNorm * TOUCH_TILT_FACTOR;
      tiltTouchOffset = clamp(dyAdjusted, -1, 1);

      updatePanTiltFromSources();
    }

    function findTouchesByIds(touches, ids) {
      const result = [];
      for (let i = 0; i < touches.length; i++) {
        const t = touches[i];
        if (ids.includes(t.identifier)) {
          result.push(t);
        }
      }
      return result;
    }

    function calcTwoFingerBase(t1, t2) {
      const p1 = getLocalPos(t1, pad);
      const p2 = getLocalPos(t2, pad);
      const dx = p1.x - p2.x;
      const dy = p1.y - p2.y;
      const dist = Math.hypot(dx, dy);
      const avgY = (p1.y + p2.y) / 2;
      return { dist, avgY };
    }

    pad.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touches = e.touches;

      if (touches.length === 1) {
        const t = touches[0];
        joystickTouchId = t.identifier;
        twoFingerMode = 'none';
        twoFingerIds = [];

        const pos = getLocalPos(t, pad);
        pendingJoystick = true;
        pendingStartX = pos.x;
        pendingStartY = pos.y;

        const dotPos = dotCenterInLocal();
        const dx = pos.x - dotPos.x;
        const dy = pos.y - dotPos.y;
        const dist = Math.hypot(dx, dy);
        if (dist <= DOT_GRAB_RADIUS) {
          pendingJoystick = false;
          handleJoystickMoveTouch(t);
        }
      } else if (touches.length === 2) {
        joystickTouchId = null;
        pendingJoystick = false;

        panTouchOffset = 0;
        tiltTouchOffset = 0;
        updatePanTiltFromSources();

        twoFingerMode = 'unknown';
        const t1 = touches[0];
        const t2 = touches[1];
        twoFingerIds = [t1.identifier, t2.identifier];

        const { dist, avgY } = calcTwoFingerBase(t1, t2);
        pinchStartDist = dist;
        pinchStartZoom = zoom;
        twoStartAvgY = avgY;
        twoStartDimmer = dimmer;
      } else {
        joystickTouchId = null;
        pendingJoystick = false;
        twoFingerMode = 'none';
        twoFingerIds = [];
      }

      updateTexts();
    }, { passive: false });

    pad.addEventListener('touchmove', (e) => {
      e.preventDefault();
      const touches = e.touches;

      if (touches.length === 1 && joystickTouchId !== null) {
        const t = Array.from(touches).find(t => t.identifier === joystickTouchId) || touches[0];

        if (pendingJoystick) {
          const pos = getLocalPos(t, pad);
          const dx = pos.x - pendingStartX;
          const dy = pos.y - pendingStartY;
          const dist = Math.hypot(dx, dy);

          if (dist >= JOYSTICK_ACTIVATION_DIST) {
            pendingJoystick = false;
            handleJoystickMoveTouch(t);
          } else {
            updateTexts();
          }
        } else {
          handleJoystickMoveTouch(t);
        }
      } else if (touches.length === 2 && twoFingerIds.length === 2) {
        const [id1, id2] = twoFingerIds;
        const twoTouches = findTouchesByIds(touches, twoFingerIds);
        if (twoTouches.length < 2) return;

        const t1 = twoTouches.find(t => t.identifier === id1) || twoTouches[0];
        const t2 = twoTouches.find(t => t.identifier === id2) || twoTouches[1];

        const { dist, avgY } = calcTwoFingerBase(t1, t2);
        const distDelta = dist - pinchStartDist;
        const yDelta = avgY - twoStartAvgY;

        if (twoFingerMode === 'unknown') {
          if (Math.abs(distDelta) > PINCH_DIST_THRESHOLD && Math.abs(yDelta) < DIMMER_Y_THRESHOLD) {
            twoFingerMode = 'pinch';
          } else if (Math.abs(yDelta) > DIMMER_Y_THRESHOLD && Math.abs(distDelta) < DIMMER_Y_THRESHOLD) {
            twoFingerMode = 'dimmer';
          } else {
            updateTexts();
            return;
          }
        }

        if (twoFingerMode === 'pinch') {
          // NEU: additive Zoom-Berechnung, damit Zoom=0 nicht „festklebt“
          const rect = pad.getBoundingClientRect();
          const maxRef = Math.min(rect.width, rect.height) || 1;
          const deltaNorm = distDelta / maxRef;
          const SENSITIVITY = 1.2;
          zoom = clamp(pinchStartZoom + deltaNorm * SENSITIVITY, 0, 1);
        } else if (twoFingerMode === 'dimmer') {
          const rect = pad.getBoundingClientRect();
          const relative = -yDelta / rect.height;
          dimmer = clamp(twoStartDimmer + relative, 0, 1);
        }

        syncZoomDimmerFadersFromValues();
        updateDot();
        updateTexts();
        sendStateToServer();
      }
    }, { passive: false });

    pad.addEventListener('touchend', (e) => {
      e.preventDefault();
      const touches = e.touches;

      if (touches.length === 0) {
        joystickTouchId = null;
        pendingJoystick = false;
        twoFingerMode = 'none';
        twoFingerIds = [];
        panTouchOffset = 0;
        tiltTouchOffset = 0;
        updatePanTiltFromSources();
      } else if (touches.length === 1) {
        const t = touches[0];
        joystickTouchId = t.identifier;
        pendingJoystick = true;

        const pos = getLocalPos(t, pad);
        pendingStartX = pos.x;
        pendingStartY = pos.y;

        twoFingerMode = 'none';
        twoFingerIds = [];
        updateTexts();
      } else if (touches.length === 2) {
        const t1 = touches[0];
        const t2 = touches[1];
        twoFingerIds = [t1.identifier, t2.identifier];
        twoFingerMode = 'unknown';
        pendingJoystick = false;

        const { dist, avgY } = calcTwoFingerBase(t1, t2);
        pinchStartDist = dist;
        pinchStartZoom = zoom;
        twoStartAvgY = avgY;
        twoStartDimmer = dimmer;
        updateTexts();
      }
    }, { passive: false });

    pad.addEventListener('touchcancel', (e) => {
      e.preventDefault();
      joystickTouchId = null;
      pendingJoystick = false;
      twoFingerMode = 'none';
      twoFingerIds = [];
      panTouchOffset = 0;
      tiltTouchOffset = 0;
      updatePanTiltFromSources();
    }, { passive: false });

    /*************************************************
     * Gamepad-Integration
     *************************************************/
    let currentGamepadIndex = null;
    let gamepadConnected    = false;
    let lastGamepadTime     = null;
    let prevButtonPressed   = [];

    const STICK_DEADZONE        = 0.15;
    const LEFT_STICK_SCALE      = 1.0;
    const RIGHT_STICK_SCALE     = 0.2;
    const ZOOM_FULL_RANGE_SEC   = 2.0;
    const DIMMER_FULL_RANGE_SEC = 1.0;
    const FADE_BUTTON_DURATION  = 1.0;

    let dimmerFade = null;
    let zoomFade   = null;

    function applyDeadzone(v) {
      return Math.abs(v) < STICK_DEADZONE ? 0 : v;
    }

    function startDimmerFade(target, duration = FADE_BUTTON_DURATION) {
      dimmerFade = {
        from: dimmer,
        to: clamp(target, 0, 1),
        t: 0,
        duration: Math.max(0.01, duration)
      };
    }

    function startZoomFade(target, duration = FADE_BUTTON_DURATION) {
      zoomFade = {
        from: zoom,
        to: clamp(target, 0, 1),
        t: 0,
        duration: Math.max(0.01, duration)
      };
    }

    function updateFades(dt) {
      if (dimmerFade) {
        dimmerFade.t += dt;
        const tt = clamp(dimmerFade.t / dimmerFade.duration, 0, 1);
        dimmer = dimmerFade.from + (dimmerFade.to - dimmerFade.from) * tt;
        if (tt >= 1) dimmerFade = null;
      }
      if (zoomFade) {
        zoomFade.t += dt;
        const tt = clamp(zoomFade.t / zoomFade.duration, 0, 1);
        zoom = zoomFade.from + (zoomFade.to - zoomFade.from) * tt;
        if (tt >= 1) zoomFade = null;
      }
    }

    function gamepadLoop(timestamp) {
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      let gp = null;

      if (pads && pads.length) {
        if (currentGamepadIndex != null && pads[currentGamepadIndex]) {
          gp = pads[currentGamepadIndex];
        }
        if (!gp) {
          for (let i = 0; i < pads.length; i++) {
            if (pads[i]) {
              gp = pads[i];
              currentGamepadIndex = i;
              break;
            }
          }
        }
      }

      if (!gp) {
        if (gamepadConnected && statusEl) {
          console.log('Gamepad getrennt');
          statusEl.textContent = 'Gamepad getrennt';
          gamepadConnected = false;
        }
        panCtrlOffset = 0;
        tiltCtrlOffset = 0;
        updatePanTiltFromSources();
        lastGamepadTime = timestamp;
        requestAnimationFrame(gamepadLoop);
        return;
      }

      if (!gamepadConnected) {
        console.log('Gamepad verbunden:', gp.id);
        if (statusEl) statusEl.textContent = `Gamepad verbunden: ${gp.id}`;
        gamepadConnected = true;
        prevButtonPressed = (gp.buttons || []).map(b => b.pressed);
        lastGamepadTime = timestamp;
      }

      let dt = 0;
      if (lastGamepadTime != null) {
        dt = (timestamp - lastGamepadTime) / 1000;
      } else {
        dt = 0;
      }
      lastGamepadTime = timestamp;

      const axes    = gp.axes || [];
      const buttons = gp.buttons || [];

      const lxRaw = axes[0] || 0;
      const lyRaw = axes[1] || 0;
      const rxRaw = axes[2] || 0;
      const ryRaw = axes[3] || 0;

      const lx = applyDeadzone(lxRaw);
      const ly = applyDeadzone(lyRaw);
      const rx = applyDeadzone(rxRaw);
      const ry = applyDeadzone(ryRaw);

      const combinedX = lx * LEFT_STICK_SCALE + rx * RIGHT_STICK_SCALE;
      const combinedY = (ly * LEFT_STICK_SCALE + ry * RIGHT_STICK_SCALE) * GAMEPAD_TILT_FACTOR;

      panCtrlOffset  = clamp(combinedX, -1, 1);
      tiltCtrlOffset = clamp(combinedY, -1, 1);

      updatePanTiltFromSources();

      updateFades(dt);

      const lt = buttons[6] ? buttons[6].value : 0;
      const rt = buttons[7] ? buttons[7].value : 0;

      if (lt > 0.05 || rt > 0.05) {
        zoomFade = null;
        const dir = rt - lt;
        const dZoom = dir * (dt || 0.016) / ZOOM_FULL_RANGE_SEC;
        zoom = clamp(zoom + dZoom, 0, 1);
      }

      const lb = buttons[4]?.pressed;
      const rb = buttons[5]?.pressed;

      if (lb || rb) {
        dimmerFade = null;
        let dDim = 0;
        if (lb) dDim -= (dt || 0.016) / DIMMER_FULL_RANGE_SEC;
        if (rb) dDim += (dt || 0.016) / DIMMER_FULL_RANGE_SEC;
        dimmer = clamp(dimmer + dDim, 0, 1);
      }

      if (!prevButtonPressed.length) {
        prevButtonPressed = buttons.map(b => b.pressed);
      }

      buttons.forEach((b, idx) => {
        const was = prevButtonPressed[idx] || false;
        const is  = b.pressed;

        if (is && !was) {
          switch (idx) {
            case 0: // A
              startDimmerFade(0.0);
              break;
            case 3: // Y
              startDimmerFade(1.0);
              break;
            case 2: // X
              startZoomFade(1.0);
              break;
            case 1: // B
              startZoomFade(0.0);
              break;
            default:
              break;
          }
        }

        prevButtonPressed[idx] = is;
      });

      syncZoomDimmerFadersFromValues();
      updateDot();
      updateTexts();
      sendStateToServer();

      requestAnimationFrame(gamepadLoop);
    }

    requestAnimationFrame(gamepadLoop);

    /*************************************************
     * Pad-Sensitivity-Fader
     *************************************************/
    function buildSensitivityFader(initialScale = 1.0) {
      if (sensitivityFaderState || !sensitivityFaderHost) return;

      padSpeedScale = clamp(initialScale, 0.1, 1.0);

      const wrapper = document.createElement('div');
      wrapper.className = 'fader';

      const track = document.createElement('div');
      track.className = 'fader-track';

      const thumb = document.createElement('div');
      thumb.className = 'fader-thumb sensitivity';

      track.appendChild(thumb);
      wrapper.appendChild(track);
      sensitivityFaderHost.appendChild(wrapper);

      // sliderValue: 0 (unten, schnell) .. 1 (oben, fein)
      let sliderValue = (1 - padSpeedScale) / 0.9; // invert Mapping

      const state = {
        value: sliderValue,
        wrapper,
        track,
        thumb,
        pointerId: null
      };
      sensitivityFaderState = state;

      function updateThumbPosition() {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);
        const v = state.value;
        const bottomPx = v * travel;
        thumb.style.bottom = `${bottomPx}px`;
      }

      function applySliderValue(sendToServer = true) {
        // slider 0..1 => scale 1.0 .. 0.1
        padSpeedScale = clamp(1 - 0.9 * state.value, 0.1, 1.0);
        updateThumbPosition();
        if (sendToServer) {
          sendPadSensitivityToServer();
        }
      }

      function setValueFromClientY(clientY, send = true) {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);

        let y = clientY - rect.top - thumbHeight / 2;
        y = clamp(y, 0, travel);

        const v = 1 - (y / travel); // 0 unten, 1 oben
        state.value = clamp(v, 0, 1);

        applySliderValue(send);
      }

      track.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        track.setPointerCapture(e.pointerId);
        state.pointerId = e.pointerId;
        wrapper.classList.add('active');
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointermove', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        if (e.buttons === 0) return;
        e.preventDefault();
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointerup', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      track.addEventListener('pointercancel', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      // initiale Position nach Layout
      requestAnimationFrame(() => {
        applySliderValue(false);
      });
    }

    function setPadSpeedScaleFromServer(scale) {
      padSpeedScale = clamp(scale, 0.1, 1.0);
      if (!sensitivityFaderState) {
        buildSensitivityFader(padSpeedScale);
      } else {
        sensitivityFaderState.value = (1 - padSpeedScale) / 0.9;
        const state = sensitivityFaderState;
        const track = state.track;
        const thumb = state.thumb;
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);
        const bottomPx = state.value * travel;
        thumb.style.bottom = `${bottomPx}px`;
      }
    }

    /*************************************************
     * Allgemeiner Value-Fader (für Zoom/Dimmer)
     *************************************************/
    function createValueFader(parentEl, labelText, initialValue, onChange) {
      const wrapper = document.createElement('div');
      wrapper.className = 'fader';
      // etwas kompakter als die großen Fader
      wrapper.style.setProperty('--fader-width', '70px');
      wrapper.style.setProperty('--fader-height', '260px');
      wrapper.style.setProperty('--fader-track-height', '200px');

      const nameEl = document.createElement('div');
      nameEl.className = 'fader-name';
      nameEl.textContent = labelText;

      const track = document.createElement('div');
      track.className = 'fader-track';

      const thumb = document.createElement('div');
      thumb.className = 'fader-thumb';

      track.appendChild(thumb);
      wrapper.appendChild(track);
      wrapper.appendChild(nameEl);
      parentEl.appendChild(wrapper);

      const state = {
        value: clamp(initialValue ?? 0, 0, 1),
        wrapper,
        track,
        thumb,
        pointerId: null
      };

      function updateThumbPosition() {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);
        const v = state.value;
        const bottomPx = v * travel;
        thumb.style.bottom = `${bottomPx}px`;
      }

      function applyValue(send = true) {
        state.value = clamp(state.value, 0, 1);
        updateThumbPosition();
        if (send && typeof onChange === 'function') {
          onChange(state.value);
        }
      }

      function setValueFromClientY(clientY, send = true) {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);

        let y = clientY - rect.top - thumbHeight / 2;
        y = clamp(y, 0, travel);

        const v = 1 - (y / travel); // 0 unten, 1 oben
        state.value = clamp(v, 0, 1);
        applyValue(send);
      }

      state.setValue = function(v, send = false) {
        state.value = clamp(v, 0, 1);
        applyValue(send);
      };

      track.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        track.setPointerCapture(e.pointerId);
        state.pointerId = e.pointerId;
        wrapper.classList.add('active');
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointermove', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        if (e.buttons === 0) return;
        e.preventDefault();
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointerup', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      track.addEventListener('pointercancel', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      requestAnimationFrame(updateThumbPosition);
      return state;
    }

    function buildZoomDimmerFaders() {
      if (!zoomDimmerContainer) return;
      zoomDimmerContainer.innerHTML = '';
	  

      zoomFaderState = createValueFader(
        zoomDimmerContainer,
        'Zoom',
        zoom,
        (v) => {
          zoom = v;
          updateTexts();
          sendStateToServer();
        }
      );
	  zoomFaderState.thumb.className = 'fader-thumb zoom';

      dimmerFaderState = createValueFader(
        zoomDimmerContainer,
        'Dimmer',
        dimmer,
        (v) => {
          dimmer = v;
          updateTexts();
          sendStateToServer();
        }
      );
	  dimmerFaderState.thumb.className = 'fader-thumb dimmer';
    }

    function syncZoomDimmerFadersFromValues() {
      if (zoomFaderState) {
        zoomFaderState.setValue(zoom, false);
      }
      if (dimmerFaderState) {
        dimmerFaderState.setValue(dimmer, false);
      }
    }

    /*************************************************
     * Preset-Fader (Live-Page)
     *************************************************/
    const presetFaderStates = new Map(); // preset_id -> state

    function createPresetFaderElement(preset) {
      const wrapper = document.createElement('div');
      wrapper.className = 'fader';

      const track = document.createElement('div');
      track.className = 'fader-track';

      const thumb = document.createElement('div');
      thumb.className = 'fader-thumb';

      track.appendChild(thumb);

      const nameEl = document.createElement('div');
      nameEl.className = 'fader-name';
      nameEl.textContent = preset.name || `P${preset.id}`;

      const metaEl = document.createElement('div');
      metaEl.className = 'fader-meta';
      metaEl.textContent = `S${preset.page ?? 1}/${preset.fader_index ?? ''}`;

      wrapper.appendChild(track);
      wrapper.appendChild(nameEl);
      wrapper.appendChild(metaEl);

      const state = {
        id: preset.id,
        value: clamp(preset.level ?? 0, 0, 1),
        wrapper,
        track,
        thumb,
        pointerId: null
      };

      function updateThumbPosition() {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);
        const v = state.value;
        const bottomPx = v * travel;
        thumb.style.bottom = `${bottomPx}px`;
      }

      function setValueFromClientY(clientY, send = true) {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);

        let y = clientY - rect.top - thumbHeight / 2;
        y = clamp(y, 0, travel);

        const v = 1 - (y / travel);
        state.value = clamp(v, 0, 1);

        updateThumbPosition();
        if (send) {
          sendPresetFader(state.id, state.value);
        }
      }

      track.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        track.setPointerCapture(e.pointerId);
        state.pointerId = e.pointerId;
        wrapper.classList.add('active');
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointermove', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        if (e.buttons === 0) return;
        e.preventDefault();
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointerup', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      track.addEventListener('pointercancel', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      requestAnimationFrame(updateThumbPosition);

      return state;
    }

    function buildPresetFaders(presets) {
      presetContainer.innerHTML = '';
      presetFaderStates.clear();

      if (!presets.length) {
        presetsPageInfo.textContent = '(keine Presets definiert)';
        return;
      }

      presets.sort((a, b) => {
        if ((a.page ?? 1) !== (b.page ?? 1)) {
          return (a.page ?? 1) - (b.page ?? 1);
        }
        return (a.fader_index ?? 0) - (b.fader_index ?? 0);
      });

      const pages = Array.from(new Set(presets.map(p => p.page ?? 1)));
      presetsPageInfo.textContent = pages.length > 1
        ? `Seiten: ${pages.join(', ')}`
        : `Seite ${pages[0]}`;

      presets.forEach(p => {
        const state = createPresetFaderElement(p);
        presetContainer.appendChild(state.wrapper);
        presetFaderStates.set(p.id, state);
      });
    }

    /*************************************************
     * Programmer-Fader (alle SCENE-Kanäle)
     *************************************************/
    const programmerChannelStates = new Map(); // channel_id -> state

    function createProgrammerFaderElement(channel) {
      const wrapper = document.createElement('div');
      wrapper.className = 'fader';

      const track = document.createElement('div');
      track.className = 'fader-track';

      const thumb = document.createElement('div');
      thumb.className = 'fader-thumb';

      track.appendChild(thumb);

      const nameEl = document.createElement('div');
      nameEl.className = 'fader-name';
      nameEl.textContent = channel.name || `Ch ${channel.id}`;

      const metaEl = document.createElement('div');
      metaEl.className = 'fader-meta';
      metaEl.textContent = `U${channel.universe ?? 0}/A${channel.dmx_address ?? '-'}`;

      wrapper.appendChild(track);
      wrapper.appendChild(nameEl);
      wrapper.appendChild(metaEl);

      const state = {
        id: channel.id,
        value: 0,
        wrapper,
        track,
        thumb,
        pointerId: null
      };

      function updateThumbPosition() {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);
        const v = state.value;
        const bottomPx = v * travel;
        thumb.style.bottom = `${bottomPx}px`;
      }

      function setValueFromClientY(clientY, send = true) {
        const rect = track.getBoundingClientRect();
        const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
        const travel = Math.max(0, rect.height - thumbHeight);

        let y = clientY - rect.top - thumbHeight / 2;
        y = clamp(y, 0, travel);

        const v = 1 - (y / travel);
        state.value = clamp(v, 0, 1);

        updateThumbPosition();
        if (send) {
          sendProgrammerChannel(state.id, state.value);
        }
      }

      track.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        track.setPointerCapture(e.pointerId);
        state.pointerId = e.pointerId;
        wrapper.classList.add('active');
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointermove', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        if (e.buttons === 0) return;
        e.preventDefault();
        setValueFromClientY(e.clientY, true);
      });

      track.addEventListener('pointerup', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      track.addEventListener('pointercancel', (e) => {
        if (state.pointerId === null || e.pointerId !== state.pointerId) return;
        e.preventDefault();
        wrapper.classList.remove('active');
        state.pointerId = null;
        track.releasePointerCapture(e.pointerId);
      });

      requestAnimationFrame(updateThumbPosition);

      return state;
    }

    function buildProgrammerFaders(allChannels) {
      programmerContainer.innerHTML = '';
      programmerChannelStates.clear();

      // Kanäle mit fixed_value hält der Server konstant – ein Fader dafür
      // hätte keine Wirkung und würde wie ein Defekt wirken.
      const channels = allChannels.filter(ch => ch.fixed_value == null);

      if (!channels.length) {
        programmerContainer.textContent = 'Keine steuerbaren DMX-Kanäle im Patch gefunden.';
        return;
      }

      channels.forEach(ch => {
        const state = createProgrammerFaderElement(ch);
        programmerContainer.appendChild(state.wrapper);
        programmerChannelStates.set(ch.id, state);
      });
    }

    /*************************************************
     * „Speichern als Preset 1..16“
     *************************************************/
    function setupProgrammerSaveButtons() {
      programmerSaveButtonsEl.innerHTML = '';
      for (let i = 1; i <= 16; i++) {
        const btn = document.createElement('button');
        btn.className = 'save-button';
        btn.textContent = `Speichern als Preset ${i}`;
        btn.dataset.slot = String(i);

        btn.addEventListener('click', () => {
          saveProgrammerToPresetSlot(i);
        });

        programmerSaveButtonsEl.appendChild(btn);
      }
    }

    function findPresetBySlot(slot) {
      if (!Array.isArray(presetsFromServer)) return null;
      return presetsFromServer.find(p =>
        (p.page ?? 1) === 1 && (p.fader_index ?? slot) === slot
      ) || null;
    }

    function saveProgrammerToPresetSlot(slot) {
      const existing = findPresetBySlot(slot);
      const presetId = existing ? existing.id : null;

      // zentraler Name:
      // 1. Feld-Inhalt, wenn nicht leer
      // 2. sonst bestehender Name, falls vorhanden
      // 3. sonst "Preset X"
      let name = (programmerPresetNameInput.value || '').trim();
      if (!name) {
        if (existing && existing.name) {
          name = existing.name;
        } else {
          name = `Preset ${slot}`;
        }
      }

      const channelsPayload = [];
      programmerChannelStates.forEach((state, channelId) => {
        const v = clamp(state.value ?? 0, 0, 1);
        if (v > 0) {
          channelsPayload.push({
            channel_id: channelId,
            max_value: v
          });
        }
      });

      const msg = {
        type: 'save_preset',
        preset_id: presetId,
        name,
        page: 1,
        fader_index: slot,
        channels: channelsPayload
      };

      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) {
        alert('WebSocket nicht verbunden – Preset konnte nicht gesendet werden.');
        return;
      }

      ws.send(JSON.stringify(msg));
      if (statusEl) statusEl.textContent =
        `Preset-Speicherbefehl für Slot ${slot} gesendet (Name: "${name}", ID: ${presetId ?? 'neu'})`;
    }

    /*************************************************
     * Positions-Buttons (9 Slots, pan/tilt/zoom absolut)
     * - kurzer Klick/Tap = Recall
     * - Long-Press (~600ms) = Store
     *************************************************/
    function flashPositionSaved(button) {
      // Original-Label merken (nur einmal)
      if (!button.dataset.label) {
        button.dataset.label = button.textContent;
      }

      const baseLabel = button.dataset.label;
      button.textContent = baseLabel + ' ✓';
      button.classList.add('ml-pos-btn-saving', 'w3-teal');

      // Nach kurzer Zeit wieder zurück
      setTimeout(() => {
        button.textContent = baseLabel;
        button.classList.remove('ml-pos-btn-saving');
      }, 600);
    }

    function storePositionSlot(slot) {
      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
      const msg = {
        type: 'ml_pos_store',
        slot,
        pan,
        tilt,
        zoom
      };
      ws.send(JSON.stringify(msg));
    }

    function recallPositionSlot(slot) {
      if (!wsConnected || !ws || ws.readyState !== WebSocket.OPEN) return;
      const msg = {
        type: 'ml_pos_recall',
        slot
      };
      ws.send(JSON.stringify(msg));
      // hier wissen wir die Ziel-Zoomwerte nicht → Fader bleiben auf letztem UI-Stand
    }

    function buildPositionButtons() {
      if (!positionButtonsContainer) return;
      positionButtonsContainer.innerHTML = '';

      for (let i = 1; i <= 9; i++) {
        const btn = document.createElement('button');
        btn.className = 'pos-btn w3-button w3-teal w3-round-large';
        btn.textContent = i.toString();

        let pressTimer = null;

        const start = (ev) => {
          ev.preventDefault();
          pressTimer = setTimeout(() => {
            pressTimer = null;
            storePositionSlot(i);
            flashPositionSaved(btn);
          }, 600); // Long-Press
        };

        const end = (ev) => {
          ev.preventDefault();
          if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
            recallPositionSlot(i);  // kurzer Klick
          }
        };

        btn.addEventListener('touchstart', start, { passive: false });
        btn.addEventListener('touchend', end,   { passive: false });
        btn.addEventListener('touchcancel', end, { passive: false });

        btn.addEventListener('mousedown', start);
        btn.addEventListener('mouseup', end);
        btn.addEventListener('mouseleave', end);

        positionButtonsContainer.appendChild(btn);
      }
    }
	
	function syncZoomDimmerFadersFromState() {
	  // Zoom-Fader
	  console.log('FaderMove');
	  if (zoomFaderState) {
		zoomFaderState.value = clamp(zoom, 0, 1);
		const track = zoomFaderState.track;
		const thumb = zoomFaderState.thumb;
		const rect  = track.getBoundingClientRect();
		const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
		const travel = Math.max(0, rect.height - thumbHeight);
		const bottomPx = zoomFaderState.value * travel;
		console.log(travel);
		thumb.style.bottom = `${bottomPx}px`;
	  }

	  // Dimmer-Fader
	  if (window.dimmerFaderState) {
		dimmerFaderState.value = clamp(dimmer, 0, 1);
		const track = dimmerFaderState.track;
		const thumb = dimmerFaderState.thumb;
		const rect  = track.getBoundingClientRect();
		const thumbHeight = thumb.offsetHeight || FADER_THUMB_SIZE_PX;
		const travel = Math.max(0, rect.height - thumbHeight);
		const bottomPx = dimmerFaderState.value * travel;
		thumb.style.bottom = `${bottomPx}px`;
	  }
	}

    /*************************************************
     * Init
     *************************************************/
    setupProgrammerSaveButtons();
    buildPositionButtons();
    buildSensitivityFader(1.0); // falls Server keinen Wert schickt
    buildZoomDimmerFaders();

    showPage('live');
    updateDot();
    updateTexts();
    syncZoomDimmerFadersFromValues();
  </script>
</body>
</html>
