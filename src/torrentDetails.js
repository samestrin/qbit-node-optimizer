/************************************************************
 * File: /qbit-node-optimizer/src/torrentDetails.js
 * UPDATED:
 * - Replaced `logObj.logger` references with `logger`
 *   for consistent logging across the app.
 ************************************************************/
const db = require("./db");
const { logger } = require("./logger"); // unified
const { getTorrentsInfo } = require("./qbittorrent");
const config = require("./config");
const axios = require("axios");

/**
 * Return combined details from DB + live qBittorrent API
 */
async function fetchTorrentDetails(hash) {
  const torrentRow = await getTorrentFromDB(hash);
  const history = await getHistoryFromDB(hash);
  const qbData = await getTorrentInfoByHash(hash);

  return {
    hash,
    name: torrentRow?.name || qbData?.name,
    state: qbData?.state || torrentRow?.state,
    progress: qbData?.progress || torrentRow?.progress,
    size: qbData?.size,
    trackers: qbData?.trackers || [],
    history,
  };
}

/**
 * DB Queries
 */
function getTorrentFromDB(hash) {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM torrents WHERE hash=?`, [hash], (err, row) => {
      if (err) {
        logger.error(`[DETAILS] getTorrentFromDB error: ${err.message}`);
        return resolve(null);
      }
      resolve(row);
    });
  });
}
// Fixed graph data fetching
function getHistoryFromDB(hash) {
  return new Promise((resolve) => {
    db.all(
      `SELECT timestamp, dlspeed, progress FROM torrent_history WHERE hash=? ORDER BY timestamp DESC LIMIT 100`,
      [hash],
      (err, rows) => {
        if (err) {
          logObj.logger.error(`[DETAILS] DB error: ${err.message}`);
          return resolve([]);
        }
        resolve(rows.reverse()); // Maintain correct chronological order
      },
    );
  });
}

/**
 * Fetch additional info from qBittorrent
 */
async function getTorrentInfoByHash(hash) {
  try {
    const resp = await axios.get(`${config.qbApiUrl}/torrents/info`, {
      headers: {
        Cookie: config.cookie,
      },
    });
    const arr = resp.data;
    const found = arr.find((t) => t.hash === hash);
    if (!found) return null;

    // also fetch trackers
    const trResp = await axios.get(
      `${config.qbApiUrl}/torrents/trackers?hash=${hash}`,
      {
        headers: {
          Cookie: config.cookie,
        },
      },
    );
    found.trackers = trResp.data;
    return found;
  } catch (err) {
    logger.error(`[DETAILS] getTorrentInfoByHash error: ${err.message}`);
    return null;
  }
}

module.exports = { fetchTorrentDetails };
