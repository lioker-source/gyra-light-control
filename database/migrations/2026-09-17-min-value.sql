-- Migration: Mindestwert pro Kanal (Vorgluehen)
--
-- Einige Gluehlampen ziehen kalt einen so hohen Einschaltstrom, dass die
-- Sicherung ausloest. Ein kleiner Grundwert haelt den Faden warm. Der
-- Server gibt den Kanal nie unter min_value aus - auch nicht bei Blackout
-- oder Grandmaster 0, sonst waere der Faden beim Wiedereinschalten kalt.
--
-- Idempotent: laesst sich mehrfach ausfuehren.

USE lichtsteuerung;

SET @has_min := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'dmx_channels'
    AND COLUMN_NAME  = 'min_value'
);

SET @sql := IF(@has_min = 0,
  'ALTER TABLE dmx_channels ADD COLUMN min_value TINYINT UNSIGNED NULL AFTER fixed_value',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
