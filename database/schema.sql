-- Atrium Light database schema
-- Reconstructed from the productive server code.
-- This creates the structures required by server.js.
-- It intentionally contains NO invented presets, ML positions or live production data.

CREATE DATABASE IF NOT EXISTS lichtsteuerung
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

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

CREATE TABLE IF NOT EXISTS dmx_channels (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  universe INT NOT NULL DEFAULT 0,
  dmx_address INT NOT NULL,
  channel_group VARCHAR(32) NULL,
  -- Zugehoerigkeit zum Geraet; erlaubt das Gruppieren im Programmer.
  fixture_id INT UNSIGNED NULL,
  -- Funktion innerhalb des Fixtures: dimmer, shutter, r, g, b, a, w,
  -- pan, tilt, zoom, strobe, ctc, ...
  role VARCHAR(24) NULL,
  -- Intensitaetskanal? Nur solche Kanaele werden von Grandmaster und
  -- Blackout beeinflusst (PROTOKOLL.md 6). Pan/Tilt/Zoom/Control bleiben
  -- unangetastet, sonst wuerde ein Blackout den Kopf verstellen.
  is_intensity TINYINT(1) NOT NULL DEFAULT 0,
  sort_order INT NOT NULL DEFAULT 0,
  -- Konstant zu haltender DMX-Wert (0..255) für Fixture-Kanäle wie
  -- Shutter, Fixture-Mode oder Prisma. NULL = normal steuerbar.
  -- Ersetzt die früher im Servercode hart kodierte ID-Liste.
  fixed_value TINYINT UNSIGNED NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_universe_address (universe, dmx_address),
  KEY idx_channel_group (channel_group),
  KEY idx_sort_order (sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_fixtures (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  pan_channel_id INT UNSIGNED NOT NULL,
  pan_fine_channel_id INT UNSIGNED NULL,
  tilt_channel_id INT UNSIGNED NOT NULL,
  tilt_fine_channel_id INT UNSIGNED NULL,
  zoom_channel_id INT UNSIGNED NULL,
  dimmer_channel_id INT UNSIGNED NULL,
  -- Laufrichtung pro Fixture. Stand frueher fest im Servercode (1 - pan)
  -- und galt damit pauschal fuer jedes Movinglight.
  pan_invert TINYINT(1) NOT NULL DEFAULT 0,
  tilt_invert TINYINT(1) NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort_order INT NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  KEY idx_ml_active_sort (active, sort_order),
  CONSTRAINT fk_ml_pan FOREIGN KEY (pan_channel_id) REFERENCES dmx_channels(id),
  CONSTRAINT fk_ml_pan_fine FOREIGN KEY (pan_fine_channel_id) REFERENCES dmx_channels(id),
  CONSTRAINT fk_ml_tilt FOREIGN KEY (tilt_channel_id) REFERENCES dmx_channels(id),
  CONSTRAINT fk_ml_tilt_fine FOREIGN KEY (tilt_fine_channel_id) REFERENCES dmx_channels(id),
  CONSTRAINT fk_ml_zoom FOREIGN KEY (zoom_channel_id) REFERENCES dmx_channels(id),
  CONSTRAINT fk_ml_dimmer FOREIGN KEY (dimmer_channel_id) REFERENCES dmx_channels(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS light_presets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  page INT NOT NULL DEFAULT 1,
  fader_index INT NOT NULL,
  -- Verweis auf ml_positions.button_index; NULL = das Preset fasst die
  -- Position nicht an. Bewusst ohne Fremdschluessel (siehe Migration).
  position_slot INT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_preset_slot (page, fader_index),
  KEY idx_presets_active_page (active, page, fader_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS light_preset_values (
  preset_id INT UNSIGNED NOT NULL,
  channel_id INT UNSIGNED NOT NULL,
  max_value DECIMAL(10,6) NOT NULL DEFAULT 0,
  PRIMARY KEY (preset_id, channel_id),
  CONSTRAINT fk_preset_values_preset FOREIGN KEY (preset_id) REFERENCES light_presets(id) ON DELETE CASCADE,
  CONSTRAINT fk_preset_values_channel FOREIGN KEY (channel_id) REFERENCES dmx_channels(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_positions (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(100) NOT NULL,
  button_index INT NOT NULL,
  pan_norm DECIMAL(10,6) NOT NULL,
  tilt_norm DECIMAL(10,6) NOT NULL,
  zoom_norm DECIMAL(10,6) NOT NULL,
  fade_time_sec DECIMAL(10,3) NOT NULL DEFAULT 1.000,
  active TINYINT(1) NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uq_ml_position_button (button_index)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ml_settings (
  name VARCHAR(100) NOT NULL,
  value VARCHAR(255) NOT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO ml_settings (name, value)
VALUES ('pad_sensitivity', '1.0')
ON DUPLICATE KEY UPDATE value = value;
