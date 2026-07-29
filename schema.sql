CREATE TABLE IF NOT EXISTS readings (
  station_time INTEGER PRIMARY KEY,
  captured_at INTEGER NOT NULL,
  wind_speed REAL,
  wind_gust REAL,
  wind_direction INTEGER,
  temperature REAL,
  barometer REAL,
  gust_at INTEGER
);
