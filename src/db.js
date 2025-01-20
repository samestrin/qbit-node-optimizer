const path = require("path");
const sqlite3 = require("sqlite3").verbose();
const logObj = require("./logger");

const DB_PATH = path.join(__dirname, "..", "qbit_torrents.db");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    logObj.logger.error(`[DB] Failed to open database: ${err.message}`);
    process.exit(1);
  }
  logObj.logger.info(`[DB] Connected to SQLite database at ${DB_PATH}`);
});

db.serialize(() => {
  // Current torrent states
  db.run(`
    CREATE TABLE IF NOT EXISTS torrents (
      hash TEXT PRIMARY KEY,
      name TEXT,
      state TEXT,
      dlspeed INTEGER,
      progress REAL,
      eta INTEGER,
      num_seeds INTEGER,
      added_on INTEGER,
      last_updated INTEGER,
      slow_runs INTEGER DEFAULT 0,
      recovery_attempts INTEGER DEFAULT 0
    )
  `);

  // Historical data
  db.run(`
    CREATE TABLE IF NOT EXISTS torrent_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT,
      name TEXT,
      state TEXT,
      dlspeed INTEGER,
      progress REAL,
      eta INTEGER,
      num_seeds INTEGER,
      timestamp INTEGER
    )
  `);

  // Paused torrents
  db.run(`
    CREATE TABLE IF NOT EXISTS paused_torrents (
      hash TEXT PRIMARY KEY,
      name TEXT,
      paused_at INTEGER
    )
  `);
});

module.exports = db;
