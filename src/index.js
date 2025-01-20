/************************************************************
 * File: /qbit-node-optimizer/src/index.js
 * UPDATED:
 * - Add explicit logging of completedSize vs. rsyncMinSize
 * - Uniform usage of logger
 ************************************************************/
const { logger } = require("./logger");
const config = require("./config");
const { createLock, removeLock, setupLockHandlers } = require("./lockfile");
const app = require("./server");
const nodeCron = require("node-cron");
const { schedulerLoop } = require("./scheduler");
const { ensureNordvpnConnected } = require("./nordvpn");
const {
  isRsyncLockPresent,
  checkAndRunRsyncCondition,
} = require("./rsyncCheck");
const { isQbittorrentRunning, restartQbittorrent } = require("./qbittorrent");
const { pulseDeadTorrents } = require("./pulse");
const { exec } = require("child_process");

/**
 * Helper to get the size of the completed folder
 */
async function getCompletedFolderSize() {
  const completedFolder = config.rsyncFolder;
  if (!completedFolder) {
    logger.info("[MAIN] No rsync folder set, returning size=0.");
    return 0;
  }
  return new Promise((resolve, reject) => {
    exec(`du -sb "${completedFolder}" | cut -f1`, (err, stdout) => {
      if (err) {
        logger.error(
          `[getCompletedFolderSize] Error running du: ${err.message}`,
        );
        return reject(err);
      }
      const sizeBytes = parseInt(stdout.trim(), 10);
      if (isNaN(sizeBytes)) {
        logger.error(
          `[getCompletedFolderSize] Could not parse size from: ${stdout}`,
        );
        return resolve(0);
      }
      logger.info(
        `[MAIN] Completed folder size is ${sizeBytes} bytes (rsyncMinSize=${config.rsyncMinSize}).`,
      );
      resolve(sizeBytes);
    });
  });
}

let wasRsyncRunning = false;
let postRsyncTimer = null;

/**
 * Main entry point
 */
async function main() {
  createLock();
  setupLockHandlers();

  const running = await isQbittorrentRunning();
  if (!running) {
    logger.info("[MAIN] qBittorrent not running; attempting to start...");
    await restartQbittorrent();
  }

  // Start the Express server
  app.listen(config.webBindPort, config.webBindIp, () => {
    logger.info(
      `[MAIN] Dashboard listening at http://${config.webBindIp}:${config.webBindPort}`,
    );
  });

  // Immediately run once
  await runScheduler();

  // Cron schedule for main logic
  nodeCron.schedule(config.schedulerCron, async () => {
    await runScheduler();
  });

  // If pulse is enabled, set the cron for dead torrent pulsing
  if (config.enablePulseDeadTorrents) {
    logger.info(
      `[MAIN] Dead torrents pulse enabled. Scheduling at: ${config.pulseCron}`,
    );
    nodeCron.schedule(config.pulseCron, async () => {
      await runPulse();
    });
  }
}

/**
 * The main scheduled function
 */
async function runScheduler() {
  const rsyncRunning = isRsyncLockPresent();

  // If the rsync lock is present, skip everything
  if (rsyncRunning) {
    logger.warn(
      "[MAIN] Rsync lock present. Skipping torrent eval and VPN checks.",
    );
    wasRsyncRunning = true;
    return;
  }

  // If we previously had an rsync run, do a delayed check for NordVPN
  if (wasRsyncRunning) {
    wasRsyncRunning = false;

    if (postRsyncTimer) {
      clearTimeout(postRsyncTimer);
      postRsyncTimer = null;
    }

    postRsyncTimer = setTimeout(async () => {
      if (config.enableNordvpn) {
        logger.info("[MAIN] 60s after rsync ended, checking NordVPN...");
        try {
          await ensureNordvpnConnected();
        } catch (err) {
          logger.error(
            `[MAIN] NordVPN check error after rsync: ${err.message}`,
          );
        }
      }
      postRsyncTimer = null;
    }, 60000);
  }

  // Check/connect NordVPN if not skipping
  if (config.enableNordvpn) {
    try {
      await ensureNordvpnConnected();
    } catch (err) {
      logger.error(`[MAIN] NordVPN error: ${err.message}`);
    }
  }

  // Possibly skip eval if we just triggered rsync
  let skipEval = false;

  try {
    const completedSize = await getCompletedFolderSize();
    const ran = await checkAndRunRsyncCondition(completedSize);
    if (ran) {
      logger.info("[MAIN] Ran rsync script; skipping torrent eval this run.");
      skipEval = true;
    }
  } catch (err) {
    logger.error(`[MAIN] RSync check error: ${err.message}`);
  }

  // If lock file got created after we started, skip
  if (isRsyncLockPresent()) {
    skipEval = true;
  }

  // Now run the main scheduler loop
  await schedulerLoop(skipEval);
}

/**
 * The "pulse dead torrents" logic
 */
async function runPulse() {
  if (isRsyncLockPresent()) {
    logger.warn("[PULSE] Skipping because rsync lock is present.");
    return;
  }

  if (config.enableNordvpn) {
    try {
      await ensureNordvpnConnected();
    } catch (err) {
      logger.error(`[PULSE] NordVPN error: ${err.message}`);
    }
  }

  await pulseDeadTorrents();
}

/**
 * Cleanup on exit
 */
process.on("exit", removeLock);
process.on("SIGINT", () => process.exit());
process.on("SIGTERM", () => process.exit());

main().catch((err) => {
  logger.error(`[MAIN] Uncaught error: ${err.message}`);
  process.exit(1);
});
