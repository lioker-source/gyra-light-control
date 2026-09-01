-- Migration: Fixtures als eigenes Objekt (Programmer nach Geraet gruppieren)
--
-- Bisher kannte das Schema nur einzelne `dmx_channels` mit einem groben
-- `channel_group` (dimmer/led/ml) und daneben `ml_fixtures` fuer die
-- Movinglights. Damit laesst sich im Programmer nicht sagen, welche Kanaele
-- zu welchem Geraet gehoeren - noetig, sobald man je Fixture auf- und
-- zuklappen will und sobald es mehrere Bauarten gibt (RGBW neben RGBAW).
--
-- `role` benennt die Funktion des Kanals innerhalb seines Fixtures
-- ('dimmer', 'shutter', 'r', 'g', 'b', 'a', 'w', 'pan', 'tilt', ...).
-- `channel_group` bleibt erhalten und beschreibt weiterhin die Art des
-- Geraets; `is_intensity` bleibt die Grundlage fuer Grandmaster/Blackout.
--
-- Idempotent: laesst sich mehrfach ausfuehren.

USE lichtsteuerung;

CREATE TABLE IF NOT EXISTS fixtures (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(100) NOT NULL,
  -- 'dimmer' | 'dimmer_shutter' | 'rgbw' | 'rgbaw' | 'moving_head'
  fixture_type  VARCHAR(32)  NOT NULL,
  universe      INT          NOT NULL DEFAULT 0,
  start_address INT          NOT NULL,
  sort_order    INT          NOT NULL DEFAULT 0,
  active        TINYINT(1)   NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  KEY idx_fixtures_sort (active, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- dmx_channels.fixture_id
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'dmx_channels'
    AND COLUMN_NAME  = 'fixture_id'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE dmx_channels ADD COLUMN fixture_id INT UNSIGNED NULL AFTER channel_group',
  'SELECT "fixture_id existiert bereits"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- dmx_channels.role
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'dmx_channels'
    AND COLUMN_NAME  = 'role'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE dmx_channels ADD COLUMN role VARCHAR(24) NULL AFTER fixture_id',
  'SELECT "role existiert bereits"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

-- Index auf fixture_id
SET @exists := (
  SELECT COUNT(*) FROM information_schema.STATISTICS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'dmx_channels'
    AND INDEX_NAME   = 'idx_channels_fixture'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE dmx_channels ADD KEY idx_channels_fixture (fixture_id)',
  'SELECT "Index existiert bereits"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
