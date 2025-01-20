const axios = require("axios");
const { exec } = require("child_process");
const db = require("./db");
const logObj = require("./logger");
const config = require("./config");

const axiosInstance = axios.create({
  baseURL: config.qbApiUrl,
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Cookie: config.cookie,
  },
});

/**
 * Checks if qbittorrent process is running locally (by pgrep).
 */
async function isQbittorrentRunning() {
  return new Promise((resolve) => {
    exec("pgrep -x qbittorrent", (error) => {
      resolve(!error);
    });
  });
}

/**
 * Attempt to kill and restart qBittorrent.
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
 * Get general torrent info from qBittorrent.
 */
async function getTorrentsInfo() {
  const resp = await axiosInstance.get("/torrents/info");
  return resp.data;
}

/**
 * Transfer info includes speeds, etc.
 */
async function getTransferInfo() {
  const resp = await axiosInstance.get("/transfer/info");
  return resp.data;
}

/**
 * Pause torrent by hash.
 */
async function pauseTorrent(hash) {
  await axiosInstance.post("/torrents/pause", `hashes=${hash}`);
}

/**
 * Resume torrent by hash.
 */
async function resumeTorrent(hash) {
  await axiosInstance.post("/torrents/resume", `hashes=${hash}`);
}

/**
 * Force-resume torrent (forces it to start ignoring queue rules).
 */
async function forceResumeTorrent(hash) {
  await axiosInstance.post(
    "/torrents/setForceStart",
    `hashes=${hash}&value=true`,
  );
}

/**
 * Move torrent to top priority.
 */
async function topPriority(hash) {
  await axiosInstance.post("/torrents/topPrio", `hashes=${hash}`);
}

/**
 * Move torrent to bottom priority.
 */
async function bottomPriority(hash) {
  await axiosInstance.post("/torrents/bottomPrio", `hashes=${hash}`);
}

/**
 * Re-check torrent data for hash.
 */
async function recheckTorrent(hash) {
  await axiosInstance.post("/torrents/recheck", `hashes=${hash}`);
}

/**
 * Re-announce torrent to trackers.
 */
async function reannounceTorrent(hash) {
  await axiosInstance.post("/torrents/reannounce", `hashes=${hash}`);
}

/**
 * Set category on torrent.
 */
async function setTorrentCategory(hash, category) {
  await axiosInstance.post(
    "/torrents/setCategory",
    `hashes=${hash}&category=${encodeURIComponent(category)}`,
  );
}

/**
 * Add a tag to a torrent.
 */
async function addTag(hash, tag) {
  const form = `hashes=${hash}&tags=${encodeURIComponent(tag)}`;
  await axiosInstance.post("/torrents/addTags", form);
}

/**
 * Remove a tag from a torrent.
 */
async function removeTag(hash, tag) {
  const form = `hashes=${hash}&tags=${encodeURIComponent(tag)}`;
  await axiosInstance.post("/torrents/removeTags", form);
}

/**
 * Save the torrent state in the DB, plus add to history.
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
 * Add a list of trackers (array of strings) to a torrent.
 */
async function addTrackers(hash, trackers) {
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
  addTrackers,
};
