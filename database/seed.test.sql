-- ============================================================
-- Test-Patch für die lokale Entwicklungsumgebung.
-- KEINE Produktionsdaten. Wird nur von docker-compose geladen.
--
-- Deckungsgleich mit dem MA3-Testpatch (MA3-Universe 1 = Art-Net-Universe 0):
--   6x Dimmer            je  1 Kanal   Adresse  1 –  6
--   4x LED-Par RGB       je  3 Kanäle  Adresse  7 – 18
--   1x Hero Wash 300 TW    19 Kanäle   Adresse 19 – 37
--
-- Die Kanal-IDs sind bewusst gleich der DMX-Adresse gewählt.
--
-- Kanalbelegung des Hero Wash 300 TW nach Handbuch (19-Kanal-Modus).
--
-- Das Leuchtmittel sind die sechs Weiss-Segmente (rel. 9-14). Sie stehen
-- hier fest auf 255, damit Dimmer/Pan/Tilt/Zoom aus der App unmittelbar
-- sichtbar werden. Wer Kalt-/Warmweiss mischen will, setzt bei diesen
-- Kanaelen fixed_value auf NULL - dann tauchen sie im Programmer auf.
-- ============================================================

USE lichtsteuerung;

INSERT INTO dmx_channels (id, name, universe, dmx_address, channel_group, sort_order, fixed_value) VALUES
  -- 2 Dimmer, Mode 0 – je ein Kanal
  ( 1, 'Dim 1',              0,  1, 'dimmer', 10, NULL),
  ( 2, 'Dim 2',              0,  2, 'dimmer', 11, NULL),
  ( 3, 'Dim 3',              0,  3, 'dimmer', 12, NULL),
  ( 4, 'Dim 4',              0,  4, 'dimmer', 13, NULL),
  ( 5, 'Dim 5',              0,  5, 'dimmer', 14, NULL),
  ( 6, 'Dim 6',              0,  6, 'dimmer', 15, NULL),

  -- 3 LED - RGB, 8 bit – je drei Kanäle
  ( 7, 'RGB 1 Rot',          0,  7, 'led',    20, NULL),
  ( 8, 'RGB 1 Grün',         0,  8, 'led',    21, NULL),
  ( 9, 'RGB 1 Blau',         0,  9, 'led',    22, NULL),

  (10, 'RGB 2 Rot',          0, 10, 'led',    23, NULL),
  (11, 'RGB 2 Grün',         0, 11, 'led',    24, NULL),
  (12, 'RGB 2 Blau',         0, 12, 'led',    25, NULL),

  (13, 'RGB 3 Rot',          0, 13, 'led',    26, NULL),
  (14, 'RGB 3 Grün',         0, 14, 'led',    27, NULL),
  (15, 'RGB 3 Blau',         0, 15, 'led',    28, NULL),

  (16, 'RGB 4 Rot',          0, 16, 'led',    29, NULL),
  (17, 'RGB 4 Grün',         0, 17, 'led',    30, NULL),
  (18, 'RGB 4 Blau',         0, 18, 'led',    31, NULL),

  -- 5 Hero Wash 300 TW, 19 channel  (rel. Kanal 1-19 = Adresse 19-37)
  (19, 'Wash Pan',            0, 19, 'ml',     40, NULL),   -- rel  1
  (20, 'Wash Pan Fine',       0, 20, 'ml',     41, NULL),   -- rel  2
  (21, 'Wash Tilt',           0, 21, 'ml',     42, NULL),   -- rel  3
  (22, 'Wash Tilt Fine',      0, 22, 'ml',     43, NULL),   -- rel  4
  (23, 'Wash P/T Speed',      0, 23, 'ml',     44,    0),   -- rel  5: 0 = schnell
  (24, 'Wash Zoom',           0, 24, 'ml',     45, NULL),   -- rel  6
  (25, 'Wash Dimmer',         0, 25, 'ml',     46, NULL),   -- rel  7
  (26, 'Wash Stroboskop',     0, 26, 'ml',     47,  255),   -- rel  8: 251-255 = LEDs an
  (27, 'Wash Kaltweiss 1',    0, 27, 'ml',     48,  255),   -- rel  9
  (28, 'Wash Warmweiss 1',    0, 28, 'ml',     49,  255),   -- rel 10
  (29, 'Wash Kaltweiss 2',    0, 29, 'ml',     50,  255),   -- rel 11
  (30, 'Wash Warmweiss 2',    0, 30, 'ml',     51,  255),   -- rel 12
  (31, 'Wash Kaltweiss 3',    0, 31, 'ml',     52,  255),   -- rel 13
  (32, 'Wash Warmweiss 3',    0, 32, 'ml',     53,  255),   -- rel 14
  (33, 'Wash Farbtemperatur', 0, 33, 'ml',     54,  128),   -- rel 15: 10-255 = 2500-6100 K
  (34, 'Wash Segment-Pattern',0, 34, 'ml',     55,    0),   -- rel 16: 0-5 = ohne Funktion
  (35, 'Wash Pattern-Ueberg.',0, 35, 'ml',     56,    0),   -- rel 17
  (36, 'Wash Zoom-Automatik', 0, 36, 'ml',     57,    0),   -- rel 18: 0-9 = ohne Funktion
  (37, 'Wash P/T-Automatik',  0, 37, 'ml',     58,    0);   -- rel 19: 0-10 = ohne Funktion

-- pan_invert = 1 entspricht dem frueheren fest verdrahteten Verhalten.
INSERT INTO ml_fixtures
  (id, name, pan_channel_id, pan_fine_channel_id, tilt_channel_id, tilt_fine_channel_id,
   zoom_channel_id, dimmer_channel_id, pan_invert, tilt_invert, active, sort_order)
VALUES
  (1, 'Hero Wash 300 TW', 19, 20, 21, 22, 24, 25, 1, 0, 1, 1);

-- Beispiel-Presets, damit die Live-Seite nicht leer ist.
INSERT INTO light_presets (id, name, page, fader_index, active) VALUES
  (1, 'Dimmer Full', 1, 1, 1),
  (2, 'LED Warm',    1, 2, 1);

INSERT INTO light_preset_values (preset_id, channel_id, max_value) VALUES
  (1,  1, 1.000000),
  (1,  2, 1.000000),
  (1,  3, 1.000000),
  (1,  4, 1.000000),
  (1,  5, 1.000000),
  (1,  6, 1.000000),

  (2,  7, 1.000000),
  (2,  8, 0.400000),
  (2,  9, 0.100000),
  (2, 10, 1.000000),
  (2, 11, 0.400000),
  (2, 12, 0.100000),
  (2, 13, 1.000000),
  (2, 14, 0.400000),
  (2, 15, 0.100000),
  (2, 16, 1.000000),
  (2, 17, 0.400000),
  (2, 18, 0.100000);

-- Intensitaetskanaele kennzeichnen (Grandmaster/Blackout, PROTOKOLL.md 6).
-- Dimmer 1-6, RGB 7-18 und der Wash-Dimmer 25. Bewusst nicht die
-- Weiss-Segmente 27-32: die sind das Leuchtmittel, nicht der Regler.
UPDATE dmx_channels SET is_intensity = 1 WHERE dmx_address BETWEEN 1 AND 18;
UPDATE dmx_channels SET is_intensity = 1 WHERE dmx_address = 25;

INSERT INTO ml_settings (name, value) VALUES
  ('pad_sensitivity', '1.0')
ON DUPLICATE KEY UPDATE value = VALUES(value);
