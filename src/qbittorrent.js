/** File: /qbit-node-optimizer/src/qbittorrent.js ***************************************/

const axios = require("axios");
const { exec } = require("child_process");
const db = require("./db");
const logObj = require("./logger");
const config = require("./config");

// Create a reusable Axios instance with qbittorrent's base URL & auth cookie
const axiosInstance = axios.create({
  baseURL: config.qbApiUrl,
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: config.cookie,
  },
});

/**
 * Check if qBittorrent process is running via pgrep
 */
async function isQbittorrentRunning() {
  return new Promise((resolve) => {
    exec("pgrep -x qbittorrent", (error) => {
      resolve(!error);
    });
  });
}

/**
 * Attempt to restart qBittorrent
 */
async function restartQbittorrent() {
  logObj.logger.info("[QBIT] Attempting to restart qBittorrent...");
  return new Promise((resolve, reject) => {
    exec("pkill -x qbittorrent", () => {
      exec("nohup qbittorrent &", (error) => {
        if (error) {
          logObj.logger.error(
            `[QBIT] Failed to start qbittorrent: ${error.message}`,
          );
          return reject(error);
        }
        logObj.logger.info("[QBIT] qBittorrent started successfully.");
        resolve();
      });
    });
  });
}

/**
 * Fetch complete torrent info array
 */
async function getTorrentsInfo() {
  const resp = await axiosInstance.get("/torrents/info");
  return resp.data;
}

/**
 * Transfer info (speeds, etc.)
 */
async function getTransferInfo() {
  const resp = await axiosInstance.get("/transfer/info");
  return resp.data;
}

/**
 * Pause a torrent
 */
async function pauseTorrent(hash) {
  await axiosInstance.post("/torrents/pause", `hashes=${hash}`);
}

/**
 * Resume a torrent
 */
async function resumeTorrent(hash) {
  await axiosInstance.post("/torrents/resume", `hashes=${hash}`);
}

/**
 * Force-resume a torrent
 */
async function forceResumeTorrent(hash) {
  await axiosInstance.post(
    "/torrents/setForceStart",
    `hashes=${hash}&value=true`,
  );
}

/**
 * Move a torrent to top priority
 */
async function topPriority(hash) {
  await axiosInstance.post("/torrents/topPrio", `hashes=${hash}`);
}

/**
 * Move a torrent to bottom priority
 */
async function bottomPriority(hash) {
  await axiosInstance.post("/torrents/bottomPrio", `hashes=${hash}`);
}

/**
 * Re-check a torrent's data
 */
async function recheckTorrent(hash) {
  await axiosInstance.post("/torrents/recheck", `hashes=${hash}`);
}

/**
 * Re-announce a torrent to trackers
 */
async function reannounceTorrent(hash) {
  await axiosInstance.post("/torrents/reannounce", `hashes=${hash}`);
}

/**
 * Set a torrent's category
 */
async function setTorrentCategory(hash, category) {
  await axiosInstance.post(
    "/torrents/setCategory",
    `hashes=${hash}&category=${encodeURIComponent(category)}`,
  );
}

/**
 * Add a tag to a torrent
 */
async function addTag(hash, tag) {
  const form = `hashes=${hash}&tags=${encodeURIComponent(tag)}`;
  await axiosInstance.post("/torrents/addTags", form);
}

/**
 * Remove a tag from a torrent
 */
async function removeTag(hash, tag) {
  const form = `hashes=${hash}&tags=${encodeURIComponent(tag)}`;
  await axiosInstance.post("/torrents/removeTags", form);
}

/**
 * Insert or update torrent state in DB
 */
function saveTorrentState(t) {
  const { hash, name, state, dlspeed, progress, eta, num_seeds, added_on } = t;
  const now = Math.floor(Date.now() / 1000);

  db.run(
    `
    INSERT INTO torrents
    (hash, name, state, dlspeed, progress, eta, num_seeds, added_on, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET
      name=excluded.name,
      state=excluded.state,
      dlspeed=excluded.dlspeed,
      progress=excluded.progress,
      eta=excluded.eta,
      num_seeds=excluded.num_seeds,
      last_updated=excluded.last_updated
  `,
    [hash, name, state, dlspeed, progress, eta, num_seeds, added_on, now],
    (err) => {
      if (err) {
        logObj.logger.error(`[DB] Upsert error for ${hash}: ${err.message}`);
      }
    },
  );

  db.run(
    `
    INSERT INTO torrent_history
    (hash, name, state, dlspeed, progress, eta, num_seeds, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
    [hash, name, state, dlspeed, progress, eta, num_seeds, now],
    (err) => {
      if (err) {
        logObj.logger.error(
          `[DB] Insert history error for ${hash}: ${err.message}`,
        );
      }
    },
  );
}

/**
 * Add additional trackers to a torrent
 */
async function addTrackers(hash, trackers) {
  // qBittorrent expects newline-separated list in 'urls='
  const trackersStr = trackers.join("\n");
  const body = `hash=${hash}&urls=${encodeURIComponent(trackersStr)}`;
  await axiosInstance.post("/torrents/addTrackers", body);
}

module.exports = {
  isQbittorrentRunning,
  restartQbittorrent,
  getTorrentsInfo,
  getTransferInfo,
  pauseTorrent,
  resumeTorrent,
  forceResumeTorrent,
  topPriority,
  bottomPriority,
  recheckTorrent,
  reannounceTorrent,
  setTorrentCategory,
  addTag,
  removeTag,
  saveTorrentState,
  addTrackers, // <-- NEW
};
