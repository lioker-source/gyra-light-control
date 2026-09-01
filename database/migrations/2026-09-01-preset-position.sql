-- Migration: Presets koennen auf einen Positions-Slot verweisen.
--
-- Ein Preset speichert die Position NICHT als Pan/Tilt-Werte, sondern als
-- Verweis auf einen der Slots aus `ml_positions`. Vorteile:
--   * Pan/Tilt bleiben ausschliesslich in der Hand von Pad und Positionen -
--     Preset und Live-Pad koennen sich nicht um dieselben Kanaele streiten.
--   * Beim Hochziehen faehrt der Kopf mit der am Slot hinterlegten Fadezeit,
--     statt hart zu springen.
--   * Wird die Position umbenannt oder neu gesetzt, zieht das Preset mit.
--
-- Bewusst KEIN Fremdschluessel auf ml_positions: dort ist `button_index`
-- der fachliche Schluessel, nicht die id, und ein geloeschter Slot soll das
-- Preset nicht mitreissen. Der Server setzt position_slot beim Loeschen
-- einer Position auf NULL.
--
-- Idempotent: laesst sich mehrfach ausfuehren.

USE lichtsteuerung;

SET @exists := (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME   = 'light_presets'
    AND COLUMN_NAME  = 'position_slot'
);
SET @sql := IF(@exists = 0,
  'ALTER TABLE light_presets ADD COLUMN position_slot INT NULL AFTER fader_index',
  'SELECT "position_slot existiert bereits"');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
