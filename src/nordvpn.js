const { exec } = require("child_process");
const logObj = require("./logger");
const { enableNordvpn } = require("./config");

async function checkNordvpnStatus() {
  return new Promise((resolve, reject) => {
    exec("nordvpn status", (error, stdout) => {
      if (error) {
        return reject(error);
      }
      const match = stdout.match(/Status: (\w+)/);
      if (match) {
        resolve(match[1]); // 'Connected' or 'Disconnected'
      } else {
        resolve("Unknown");
      }
    });
  });
}

async function connectNordvpn() {
  return new Promise((resolve, reject) => {
    exec("nordvpn connect", (error, stdout) => {
      if (error) {
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

async function ensureNordvpnConnected() {
  if (!enableNordvpn) return;
  try {
    const status = await checkNordvpnStatus();
    if (status !== "Connected") {
      logObj.logger.warn(`[VPN] NordVPN is ${status}. Attempting reconnect...`);
      await connectNordvpn();
      logObj.logger.info("[VPN] NordVPN reconnected.");
    } else {
      logObj.logger.info("[VPN] NordVPN is connected.");
    }
  } catch (error) {
    logObj.logger.error(`[VPN] ensureNordvpnConnected error: ${error.message}`);
  }
}

module.exports = { ensureNordvpnConnected };
