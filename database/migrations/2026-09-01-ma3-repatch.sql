-- Patch auf den echten MA3-Stand ziehen (Screenshot vom 2026-09-01).
--
--   Dim 1-6      Adr.  1 - 6    je 1 Kanal
--   RGB 16 1     Adr.  7 - 10   LED RGBW
--   RGB 16 2     Adr. 11 - 15   LED RGBAW
--   RGB 16 3     Adr. 16 - 20   LED RGBAW
--   RGB 16 4     Adr. 21 - 24   LED RGBW
--   HW3TW13 1    Adr. 25 - 43   Hero Wash 300 TW, 19 Kanaele
--
-- Vorher lagen dort 4x RGB (7-18) und der Wash auf 19-37. Die LEDs wachsen
-- von 3 auf 4 bzw. 5 Kanaele, deshalb rueckt der Wash von 19 auf 25.
--
-- ACHTUNG: Kanaele ab Adresse 7 werden neu angelegt. Presetwerte, die auf
-- diese Kanaele zeigten, verlieren dadurch ihre Bedeutung und werden
-- geloescht - die Kanal-IDs zeigen danach auf andere Geraete. Presets, die
-- nur die Dimmer 1-6 benutzen, bleiben unberuehrt.
--
-- Setzt die Migration 2026-09-01-fixtures.sql voraus.

USE lichtsteuerung;

START TRANSACTION;

-- Alte Zuordnung loesen, damit die Fremdschluessel das Loeschen zulassen.
DELETE FROM ml_fixtures;
DELETE FROM light_preset_values WHERE channel_id >= 7;
DELETE FROM dmx_channels WHERE id >= 7;
DELETE FROM fixtures;

-- ---------------------------------------------------------------- Fixtures
INSERT INTO fixtures (id, name, fixture_type, universe, start_address, sort_order) VALUES
  ( 1, 'Dim 1',     'dimmer',      0,  1, 10),
  ( 2, 'Dim 2',     'dimmer',      0,  2, 11),
  ( 3, 'Dim 3',     'dimmer',      0,  3, 12),
  ( 4, 'Dim 4',     'dimmer',      0,  4, 13),
  ( 5, 'Dim 5',     'dimmer',      0,  5, 14),
  ( 6, 'Dim 6',     'dimmer',      0,  6, 15),
  (11, 'RGB 16 1',  'rgbw',        0,  7, 20),
  (12, 'RGB 16 2',  'rgbaw',       0, 11, 21),
  (13, 'RGB 16 3',  'rgbaw',       0, 16, 22),
  (14, 'RGB 16 4',  'rgbw',        0, 21, 23),
  (21, 'HW3TW13 1', 'moving_head', 0, 25, 30);

-- Die sechs Dimmer bleiben, bekommen nur ihre Fixture-Zuordnung.
UPDATE dmx_channels SET fixture_id = id, role = 'dimmer' WHERE id BETWEEN 1 AND 6;

-- -------------------------------------------------------------- LED-Kanaele
INSERT INTO dmx_channels (id, name, universe, dmx_address, channel_group, fixture_id, role, sort_order, fixed_value, is_intensity) VALUES
  ( 7, 'RGB 16 1 Rot',    0,  7, 'led', 11, 'r', 20, NULL, 1),
  ( 8, 'RGB 16 1 Gruen',  0,  8, 'led', 11, 'g', 21, NULL, 1),
  ( 9, 'RGB 16 1 Blau',   0,  9, 'led', 11, 'b', 22, NULL, 1),
  (10, 'RGB 16 1 Weiss',  0, 10, 'led', 11, 'w', 23, NULL, 1),

  (11, 'RGB 16 2 Rot',    0, 11, 'led', 12, 'r', 24, NULL, 1),
  (12, 'RGB 16 2 Gruen',  0, 12, 'led', 12, 'g', 25, NULL, 1),
  (13, 'RGB 16 2 Blau',   0, 13, 'led', 12, 'b', 26, NULL, 1),
  (14, 'RGB 16 2 Amber',  0, 14, 'led', 12, 'a', 27, NULL, 1),
  (15, 'RGB 16 2 Weiss',  0, 15, 'led', 12, 'w', 28, NULL, 1),

  (16, 'RGB 16 3 Rot',    0, 16, 'led', 13, 'r', 29, NULL, 1),
  (17, 'RGB 16 3 Gruen',  0, 17, 'led', 13, 'g', 30, NULL, 1),
  (18, 'RGB 16 3 Blau',   0, 18, 'led', 13, 'b', 31, NULL, 1),
  (19, 'RGB 16 3 Amber',  0, 19, 'led', 13, 'a', 32, NULL, 1),
  (20, 'RGB 16 3 Weiss',  0, 20, 'led', 13, 'w', 33, NULL, 1),

  (21, 'RGB 16 4 Rot',    0, 21, 'led', 14, 'r', 34, NULL, 1),
  (22, 'RGB 16 4 Gruen',  0, 22, 'led', 14, 'g', 35, NULL, 1),
  (23, 'RGB 16 4 Blau',   0, 23, 'led', 14, 'b', 36, NULL, 1),
  (24, 'RGB 16 4 Weiss',  0, 24, 'led', 14, 'w', 37, NULL, 1);

-- ------------------------------------------------- Hero Wash 300 TW, 19 Kan.
-- fixed_value ist jetzt ein Startwert: er gilt, solange niemand den Kanal
-- anfasst, und wird von Programmer und Presets ueberschrieben.
INSERT INTO dmx_channels (id, name, universe, dmx_address, channel_group, fixture_id, role, sort_order, fixed_value, is_intensity) VALUES
  (25, 'Wash Pan',            0, 25, 'ml', 21, 'pan',        40, NULL, 0),   -- rel  1
  (26, 'Wash Pan Fine',       0, 26, 'ml', 21, 'pan_fine',   41, NULL, 0),   -- rel  2
  (27, 'Wash Tilt',           0, 27, 'ml', 21, 'tilt',       42, NULL, 0),   -- rel  3
  (28, 'Wash Tilt Fine',      0, 28, 'ml', 21, 'tilt_fine',  43, NULL, 0),   -- rel  4
  (29, 'Wash P/T Speed',      0, 29, 'ml', 21, 'pt_speed',   44,    0, 0),   -- rel  5: 0 = schnell
  (30, 'Wash Zoom',           0, 30, 'ml', 21, 'zoom',       45, NULL, 0),   -- rel  6
  (31, 'Wash Dimmer',         0, 31, 'ml', 21, 'dimmer',     46, NULL, 1),   -- rel  7
  (32, 'Wash Stroboskop',     0, 32, 'ml', 21, 'strobe',     47,  255, 0),   -- rel  8: 251-255 = LEDs an
  (33, 'Wash Kaltweiss 1',    0, 33, 'ml', 21, 'cw1',        48,  255, 1),   -- rel  9
  (34, 'Wash Warmweiss 1',    0, 34, 'ml', 21, 'ww1',        49,  255, 1),   -- rel 10
  (35, 'Wash Kaltweiss 2',    0, 35, 'ml', 21, 'cw2',        50,  255, 1),   -- rel 11
  (36, 'Wash Warmweiss 2',    0, 36, 'ml', 21, 'ww2',        51,  255, 1),   -- rel 12
  (37, 'Wash Kaltweiss 3',    0, 37, 'ml', 21, 'cw3',        52,  255, 1),   -- rel 13
  (38, 'Wash Warmweiss 3',    0, 38, 'ml', 21, 'ww3',        53,  255, 1),   -- rel 14
  (39, 'Wash Farbtemperatur', 0, 39, 'ml', 21, 'ctc',        54,  128, 0),   -- rel 15: 10-255 = 2500-6100 K
  (40, 'Wash Segment-Muster', 0, 40, 'ml', 21, 'seg_pattern',55,    0, 0),   -- rel 16
  (41, 'Wash Muster-Uebergang',0,41, 'ml', 21, 'seg_fade',   56,    0, 0),   -- rel 17
  (42, 'Wash Zoom-Automatik', 0, 42, 'ml', 21, 'zoom_auto',  57,    0, 0),   -- rel 18
  (43, 'Wash P/T-Automatik',  0, 43, 'ml', 21, 'pt_auto',    58,    0, 0);   -- rel 19

-- Movinglight wieder verdrahten. pan_invert bleibt 1: die Laufrichtung
-- entspricht damit dem bisherigen Verhalten (Migration pan-tilt-invert).
INSERT INTO ml_fixtures
  (id, name, pan_channel_id, pan_fine_channel_id, tilt_channel_id, tilt_fine_channel_id,
   zoom_channel_id, dimmer_channel_id, pan_invert, tilt_invert, active, sort_order)
VALUES
  (1, 'HW3TW13 1', 25, 26, 27, 28, 30, 31, 1, 0, 1, 10);

COMMIT;
