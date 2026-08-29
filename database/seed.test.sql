-- ============================================================
-- Test-Patch für die lokale Entwicklungsumgebung.
-- KEINE Produktionsdaten. Wird nur von docker-compose geladen.
--
-- Testaufbau:
--   1x Halogen-Dimmer      1 Kanal   ab Adresse 1
--   1x RGBA LED-Par        4 Kanäle  ab Adresse 11
--   1x Hero Spot 300 TW   19 Kanäle  ab Adresse 21
--
-- ACHTUNG: Die Kanalbelegung des Hero Spot 300 TW ist GERATEN
-- (typisches Moving-Head-TW-Layout) und muss beim echten Patchen
-- anhand des Handbuchs korrigiert werden. Die Adressen und die
-- Reihenfolge stimmen dann evtl. nicht.
-- ============================================================

USE lichtsteuerung;

INSERT INTO dmx_channels (id, name, universe, dmx_address, channel_group, sort_order, fixed_value) VALUES
  ( 1, 'Halogen Dimmer',     0,  1, 'dimmer', 10, NULL),

  (11, 'LED-Par Rot',        0, 11, 'led',    20, NULL),
  (12, 'LED-Par Grün',       0, 12, 'led',    21, NULL),
  (13, 'LED-Par Blau',       0, 13, 'led',    22, NULL),
  (14, 'LED-Par Amber',      0, 14, 'led',    23, NULL),

  (21, 'Spot Pan',           0, 21, 'ml',     30, NULL),
  (22, 'Spot Pan Fine',      0, 22, 'ml',     31, NULL),
  (23, 'Spot Tilt',          0, 23, 'ml',     32, NULL),
  (24, 'Spot Tilt Fine',     0, 24, 'ml',     33, NULL),
  (25, 'Spot P/T Speed',     0, 25, 'ml',     34, 0),
  (26, 'Spot Dimmer',        0, 26, 'ml',     35, NULL),
  (27, 'Spot Dimmer Fine',   0, 27, 'ml',     36, 0),
  (28, 'Spot Shutter',       0, 28, 'ml',     37, 255),
  (29, 'Spot CCT',           0, 29, 'ml',     38, NULL),
  (30, 'Spot Green/Magenta', 0, 30, 'ml',     39, 128),
  (31, 'Spot Zoom',          0, 31, 'ml',     40, NULL),
  (32, 'Spot Focus',         0, 32, 'ml',     41, NULL),
  (33, 'Spot Auto-Focus',    0, 33, 'ml',     42, 0),
  (34, 'Spot Prisma',        0, 34, 'ml',     43, 0),
  (35, 'Spot Prisma Rot.',   0, 35, 'ml',     44, 0),
  (36, 'Spot Frost',         0, 36, 'ml',     45, 0),
  (37, 'Spot Effekt/Makro',  0, 37, 'ml',     46, 0),
  (38, 'Spot Control',       0, 38, 'ml',     47, 0),
  (39, 'Spot Fixture Mode',  0, 39, 'ml',     48, 0);

INSERT INTO ml_fixtures
  (id, name, pan_channel_id, pan_fine_channel_id, tilt_channel_id, tilt_fine_channel_id,
   zoom_channel_id, dimmer_channel_id, active, sort_order)
VALUES
  (1, 'Hero Spot 300 TW', 21, 22, 23, 24, 31, 26, 1, 1);

-- Zwei Beispiel-Presets, damit die Live-Seite nicht leer ist.
INSERT INTO light_presets (id, name, page, fader_index, active) VALUES
  (1, 'Halogen Full', 1, 1, 1),
  (2, 'LED Warm',     1, 2, 1);

INSERT INTO light_preset_values (preset_id, channel_id, max_value) VALUES
  (1,  1, 1.000000),
  (2, 11, 1.000000),
  (2, 12, 0.400000),
  (2, 14, 0.800000);

INSERT INTO ml_settings (name, value) VALUES
  ('pad_sensitivity', '1.0')
ON DUPLICATE KEY UPDATE value = VALUES(value);
