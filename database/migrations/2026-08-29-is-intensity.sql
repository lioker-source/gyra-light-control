-- Migration: Intensitätskanäle kennzeichnen (B2.4, PROTOKOLL.md §6)
--
-- Grandmaster und Blackout dürfen ausschliesslich Intensitäten treffen.
-- Ein Blackout, der Pan/Tilt oder den Fixture-Mode auf 0 zieht, verstellt
-- den Kopf und schaltet das Geraet womoeglich um. `channel_group` taugt
-- dafuer nicht: das Feld beschreibt die Zugehoerigkeit (dimmer/led/ml),
-- nicht die Funktion des einzelnen Kanals.
--
-- Idempotent: laesst sich mehrfach ausfuehren.

USE lichtsteuerung;

-- Spalte nur anlegen, wenn sie fehlt.
SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'dmx_channels'
    AND COLUMN_NAME  = 'is_intensity'
);

SET @sql := IF(@exists = 0,
  'ALTER TABLE dmx_channels ADD COLUMN is_intensity TINYINT(1) NOT NULL DEFAULT 0 AFTER channel_group',
  'DO 0'
);
PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Kennzeichnung fuer den Testpatch.
-- Dimmer 1-6 und RGB 7-18 sind Intensitaeten, ebenso der Wash-Dimmer (25).
-- Bewusst NICHT die Weiss-Segmente 27-32: die stehen als fixed_value
-- konstant und sind das Leuchtmittel, nicht der Regler.
UPDATE dmx_channels SET is_intensity = 1 WHERE dmx_address BETWEEN 1 AND 18;
UPDATE dmx_channels SET is_intensity = 1 WHERE dmx_address = 25;
