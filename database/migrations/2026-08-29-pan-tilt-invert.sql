-- Migration: Pan-/Tilt-Invertierung pro Fixture (B1.2)
--
-- Bisher stand die Invertierung fest im Servercode:
--   set16bit(panChannel, panFineChannel, 1 - mlState.pan)
-- Sie galt damit pauschal fuer jedes Movinglight und liess sich nur
-- durch eine Codeaenderung anpassen. Haengt ein zweiter Kopf spiegel-
-- verkehrt, war das nicht abbildbar.
--
-- Idempotent: laesst sich mehrfach ausfuehren.

USE lichtsteuerung;

SET @has_pan := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'ml_fixtures'
    AND COLUMN_NAME  = 'pan_invert'
);

SET @sql := IF(@has_pan = 0,
  'ALTER TABLE ml_fixtures ADD COLUMN pan_invert TINYINT(1) NOT NULL DEFAULT 0 AFTER dimmer_channel_id',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

SET @has_tilt := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'ml_fixtures'
    AND COLUMN_NAME  = 'tilt_invert'
);

SET @sql := IF(@has_tilt = 0,
  'ALTER TABLE ml_fixtures ADD COLUMN tilt_invert TINYINT(1) NOT NULL DEFAULT 0 AFTER pan_invert',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Bisheriges Verhalten unveraendert uebernehmen: Pan war invertiert,
-- Tilt nicht. Ohne dieses UPDATE wuerde der Kopf nach der Migration
-- seitenverkehrt fahren.
UPDATE ml_fixtures SET pan_invert = 1, tilt_invert = 0;
