/************************************************************
 * File: /qbit-node-optimizer/src/rsyncCheck.js
 * UPDATED:
 * - Use `logger` instead of `logObj.logger` for consistent logs.
 ************************************************************/
const fs = require("fs");
const { exec } = require("child_process");
const { logger } = require("./logger");
const { rsyncLockFile, rsyncMinSize, rsyncScript } = require("./config");

/**
 * Return true if the rsync lock file is present
 */
function isRsyncLockPresent() {
  return fs.existsSync(rsyncLockFile);
}

/**
 * Check if completedSize >= rsyncMinSize. If so, run the script.
 */
async function checkAndRunRsyncCondition(currentCompletedSize) {
  if (!rsyncScript || rsyncScript.trim() === "") {
    logger.info(`[RSYNC] Rsync script not set, skipping...`);
    return false;
  }
  if (rsyncMinSize <= 0) {
    logger.info(`[RSYNC] rsyncMinSize <= 0, skipping...`);
    return false;
  }

  if (currentCompletedSize >= rsyncMinSize) {
    logger.info(
      `[RSYNC] Completed folder size ${currentCompletedSize} >= ${rsyncMinSize}. Running script...`,
    );
    try {
      await runRsyncScript();
      logger.info("[RSYNC] Script completed successfully.");
      return true;
    } catch (error) {
      logger.error(`[RSYNC] Script error: ${error.message}`);
      return false;
    }
  }

  // No condition met
  return false;
}

/**
 * Actually run the script in a Promise
 */
function runRsyncScript() {
  return new Promise((resolve, reject) => {
    exec(rsyncScript, (err, stdout, stderr) => {
      if (err) {
        return reject(err);
      }
      logger.info(`[RSYNC] Output: ${stdout} ${stderr}`);
      resolve();
    });
  });
}

module.exports = {
  isRsyncLockPresent,
  checkAndRunRsyncCondition,
};
