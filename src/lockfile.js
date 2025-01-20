const fs = require("fs");
const logObj = require("./logger");
const { selfLockFile } = require("./config");

function createLock() {
  if (fs.existsSync(selfLockFile)) {
    logObj.logger.warn(
      `[LOCK] Another instance is running. Exiting. (${selfLockFile} exists)`,
    );
    process.exit(1);
  }
  fs.writeFileSync(selfLockFile, process.pid.toString(), "utf8");
  logObj.logger.info(`[LOCK] Created lock file at ${selfLockFile}`);
}

function removeLock() {
  if (fs.existsSync(selfLockFile)) {
    fs.unlinkSync(selfLockFile);
    logObj.logger.info(`[LOCK] Removed lock file from ${selfLockFile}`);
  }
}

function setupLockHandlers() {
  process.on("exit", removeLock);
  process.on("SIGINT", () => process.exit());
  process.on("SIGTERM", () => process.exit());
}

module.exports = {
  createLock,
  removeLock,
  setupLockHandlers,
};
