const fs = require("fs");
const path = require("path");
const shellEscape = require("shell-escape"); // Add this at the top
const { exec } = require("child_process");
const axios = require("axios");
const db = require("../src/db"); // SQLite instance from the main project
const { logger } = require("../src/logger");
const config = require("../src/config");

// Configuration variables
const RSYNC_FOLDER =
  config.rsyncFolder || "/home/samestrin/Downloads/completed/";
const CATEGORY_NAMES = config.categoryList || ["Plex 16TB", "Plex 5TB"];
const VPN_DISABLE_CMD = "nordvpn disconnect";
const VPN_ENABLE_CMD = "nordvpn connect";
const PLEX_SERVER = "192.168.68.99";
const RSYNC_LOCK_FILE = config.rsyncLockFile || "/tmp/rsync_media.lock";
const QB_API_URL = config.qbApiUrl || "http://localhost:8080/api/v2";

// Torrent states indicating readiness for rsync
const ELIGIBLE_STATES = [
  "uploading",
  "pausedUP",
  "queuedUP",
  "stalledUP",
  "forcedUP",
];

// Helper function: Execute a shell command
function execCommand(command) {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${stderr || error.message}`));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Helper function: Check if the VPN is enabled
async function isVPNConnected() {
  const output = await execCommand("nordvpn status");
  return output.includes("Status: Connected");
}

// Disable VPN
async function disableVPN() {
  logger.info("[RSYNC] Disabling VPN...");
  await execCommand(VPN_DISABLE_CMD);
  const connected = await isVPNConnected();
  if (connected) {
    throw new Error("Failed to disable VPN");
  }
  logger.info("[RSYNC] VPN disabled.");
}

// Enable VPN
async function enableVPN() {
  logger.info("[RSYNC] Enabling VPN...");
  await execCommand(VPN_ENABLE_CMD);
  const connected = await isVPNConnected();
  if (!connected) {
    throw new Error("Failed to enable VPN");
  }
  logger.info("[RSYNC] VPN enabled.");
}

// Check connectivity to the Plex server
async function checkConnectivity() {
  logger.info("[RSYNC] Checking connectivity to Plex server...");
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await execCommand(`ping -c 1 ${PLEX_SERVER}`);
      logger.info("[RSYNC] Plex server is reachable.");
      return;
    } catch {
      logger.warn(
        `[RSYNC] Plex server unreachable. Retry ${attempt}/${maxRetries}...`,
      );
      if (attempt === maxRetries)
        throw new Error("Plex server is unreachable.");
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// Fetch eligible torrents from the database
async function fetchEligibleTorrents() {
  logger.info("[RSYNC] Fetching eligible torrents from database...");
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT hash, name FROM torrents WHERE state IN (${ELIGIBLE_STATES.map(() => "?").join(",")})`,
      ELIGIBLE_STATES,
      (err, rows) => {
        if (err) {
          logger.error(`[RSYNC] Database error: ${err.message}`);
          reject(err);
        } else {
          resolve(rows);
        }
      },
    );
  });
}

// Verify torrents are ready for rsync
async function verifyTorrentsReady(torrents) {
  logger.info(
    `[RSYNC] Verifying ${torrents.length} torrents ready for processing...`,
  );

  const readyTorrents = [];

  for (const torrent of torrents) {
    let found = false;

    for (const category of CATEGORY_NAMES) {
      const torrentPath = path.join(RSYNC_FOLDER, category, torrent.name);

      if (
        fs.existsSync(torrentPath) &&
        fs.statSync(torrentPath).isDirectory()
      ) {
        readyTorrents.push({ ...torrent, path: torrentPath });
        found = true;
        break;
      }
    }

    if (!found) {
      logger.warn(`[RSYNC] Torrent directory not found: ${torrent.name}`);
    }
  }

  logger.info(
    `[RSYNC] Verified ${readyTorrents.length} torrents ready for processing.`,
  );
  return readyTorrents;
}

// Rsync processing
async function processRsync(torrents) {
  for (const torrent of torrents) {
    const category = CATEGORY_NAMES.find((cat) => torrent.path.includes(cat));
    if (!category) {
      logger.warn(`[RSYNC] Could not determine category for: ${torrent.path}`);
      continue;
    }

    const destination = `plex@${PLEX_SERVER}:/Volumes/${category}/_staging/${path.basename(
      torrent.path,
    )}`;
    const sourcePath = torrent.path;

    // Escape paths to handle spaces/special characters
    const escapedSource = shellEscape([sourcePath]);
    const escapedDestination = shellEscape([destination]);

    logger.info(`[RSYNC] Syncing ${torrent.path} to ${destination}...`);
    try {
      // Create staging directory if it doesn't exist
      await execCommand(
        `ssh plex@${PLEX_SERVER} "mkdir -p '/Volumes/${category}/_staging'"`,
      );

      // Perform rsync
      await execCommand(
        `rsync -a --whole-file --progress --partial --remove-source-files --timeout=90 ` +
          `-e "ssh -o Compression=no" ${escapedSource} ${escapedDestination}`,
      );

      logger.info(`[RSYNC] Sync completed for: ${torrent.name}`);

      // Remove source directory
      await execCommand(`rm -rf ${escapedSource}`);

      // Remove torrent from qBittorrent
      await removeTorrent(torrent.hash);
    } catch (error) {
      logger.error(`[RSYNC] Failed to sync ${torrent.name}: ${error.message}`);
    }
  }
}

// Remove a torrent using the qBittorrent Web API
async function removeTorrent(hash) {
  logger.info(`[RSYNC] Removing torrent: ${hash}`);
  try {
    const response = await axios.post(
      `${QB_API_URL}/torrents/delete`,
      new URLSearchParams({ hashes: hash, deleteFiles: false }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    if (response.status === 200) {
      logger.info(`[RSYNC] Successfully removed torrent: ${hash}`);
    } else {
      logger.error(
        `[RSYNC] Failed to remove torrent: ${hash} - Status: ${response.status}`,
      );
    }
  } catch (error) {
    logger.error(`[RSYNC] Error removing torrent ${hash}: ${error.message}`);
  }
}

// Main rsync function
async function runRsync() {
  if (fs.existsSync(RSYNC_LOCK_FILE)) {
    logger.warn("[RSYNC] Lock file exists. Exiting...");
    return;
  }

  fs.writeFileSync(RSYNC_LOCK_FILE, "locked");
  logger.info("[RSYNC] Created lock file.");

  try {
    const torrents = await fetchEligibleTorrents();
    if (torrents.length === 0) {
      logger.info("[RSYNC] No eligible torrents found. Exiting...");
      return;
    }

    await disableVPN();
    await checkConnectivity();

    const readyTorrents = await verifyTorrentsReady(torrents);
    if (readyTorrents.length > 0) {
      await processRsync(readyTorrents);
    }

    logger.info("[RSYNC] Rsync process complete.");
  } catch (error) {
    logger.error(`[RSYNC] Error: ${error.message}`);
  } finally {
    try {
      await enableVPN();
    } catch (error) {
      logger.error(`[RSYNC] Error enabling VPN: ${error.message}`);
    }
    fs.unlinkSync(RSYNC_LOCK_FILE);
    logger.info("[RSYNC] Removed lock file. All done!");
  }
}

runRsync().catch((error) => {
  logger.error(`[RSYNC] Uncaught error: ${error.message}`);
});
