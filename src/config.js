/** File: /qbit-node-optimizer/src/config.js ***************************************/
require("dotenv").config();

module.exports = {
  // qBittorrent / HTTP
  qbApiUrl: process.env.QB_API_URL || "http://127.0.0.1:8080/api/v2",
  qbUsername: process.env.QB_USERNAME || "",
  qbPassword: process.env.QB_PASSWORD || "",
  cookie: process.env.COOKIE || "",

  // Logging
  logLevel: process.env.LOG_LEVEL || "info",
  logMaxDays: parseInt(process.env.LOG_MAX_DAYS || "7", 10),

  // Lock files
  selfLockFile: process.env.SELF_LOCK_FILE || "/tmp/qbit_node_optimizer.lock",
  rsyncLockFile: process.env.RSYNC_LOCK_FILE || "/tmp/rsync_media.lock",

  // Scheduler thresholds
  minLiveTorrents: parseInt(process.env.MINIMUM_LIVE_TORRENTS || "10", 10),
  stallThreshold: parseInt(process.env.STALL_THRESHOLD_SECONDS || "300", 10),
  dlTimeOverride: parseInt(process.env.DL_TIME_OVERRIDE_SECONDS || "14400", 10),
  slowSpeedThreshold: parseInt(
    process.env.SLOW_SPEED_THRESHOLD_BPS || "524288",
    10,
  ),
  highPrioritySpeed: parseInt(
    process.env.HIGH_PRIORITY_SPEED_BPS || "102400",
    10,
  ),
  highPriorityPercent: parseInt(process.env.HIGH_PRIORITY_PERCENT || "95", 10),
  autoUnpauseHours: parseInt(process.env.AUTO_UNPAUSE_HOURS || "4", 10),
  maxRecoveryAttempts: parseInt(process.env.MAX_RECOVERY_ATTEMPTS || "2", 10),

  // VPN
  enableNordvpn: process.env.ENABLE_NORDVPN === "true",

  // Tagging
  unregisteredTag: process.env.UNREGISTERED_TAG || "unregistered",

  // Rsync
  rsyncMinSize: parseInt(process.env.RSYNC_MIN_SIZE || "0", 10),

  // NEW DEFAULT: switch from old bash script to Node-based script
  rsyncScript:
    process.env.RSYNC_SCRIPT ||
    "node /qbit-node-optimizer/helpers/rsyncFiles.js",

  rsyncFolder: process.env.RSYNC_FOLDER || "",

  // Scheduler cron defaults
  schedulerCron: process.env.SCHEDULER_CRON || "*/5 * * * *",

  // Pulse dead torrents
  enablePulseDeadTorrents: process.env.ENABLE_PULSE_DEAD_TORRENTS === "true",
  pulseCron: process.env.PULSE_CRON || "0 2 * * *",
  pulseDurationMin: parseInt(process.env.PULSE_DURATION_MIN || "15", 10),
  pulseBatchSize: parseInt(process.env.PULSE_BATCH_SIZE || "50", 10),

  // Web server
  webBindIp: process.env.WEB_BIND_IP || "0.0.0.0",
  webBindPort: parseInt(process.env.WEB_BIND_PORT || "3000", 10),

  // In-memory logs
  maxInMemoryLogs: parseInt(process.env.MAX_INMEMORY_LOGS || "200", 10),

  // Categories
  categoryList: (process.env.CATEGORY_NAMES || "")
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c.length > 0),

  // Bandwidth Boost
  bandwidthBoostThreshold: parseInt(
    process.env.BANDWIDTH_BOOST_THRESHOLD || "1024",
    10,
  ),
  maxForcedTorrents: parseInt(process.env.MAX_FORCED_TORRENTS || "20", 10),
  maxForcedTorrentsGroup: parseInt(
    process.env.MAX_FORCED_TORRENTS_GROUP || "5",
    10,
  ),

  // NEW: "Small Torrent Quick Wins" threshold (500 MB by default)
  smallTorrentMaxSize: parseInt(
    process.env.SMALL_TORRENT_MAX_SIZE || "524288000",
    10,
  ),

  // NEW: Recheck time window for "recheckAndResumeSmallest"
  recheckWindowStart: parseInt(process.env.RECHECK_WINDOW_START || "0", 10),
  recheckWindowEnd: parseInt(process.env.RECHECK_WINDOW_END || "5", 10),

  // NEW: Fallback trackers for stuck torrents (comma-separated in env)
  fallbackTrackers: (process.env.FALLBACK_TRACKERS || "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0),
};
