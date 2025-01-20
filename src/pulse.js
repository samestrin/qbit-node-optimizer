const db = require("./db");
const logObj = require("./logger");
const {
  getTorrentsInfo,
  pauseTorrent,
  resumeTorrent,
  reannounceTorrent,
} = require("./qbittorrent");
const { pulseDurationMin, pulseBatchSize } = require("./config");

/**
 * Once a day "pulse" for dead torrents, also unpauses any that have the "hard pause" tag (app_hard_paused),
 * to see if they can recover, then re-pauses if still dead.
 */
async function pulseDeadTorrents() {
  logObj.logger.info("[PULSE] Starting dead-torrents pulse...");

  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[PULSE] Error fetching torrents: ${err.message}`);
    return;
  }

  // "dead" => paused or stalled + no speed/seeds/eta
  const deadCandidates = torrents.filter((t) => {
    const pausedOrStalled =
      t.state.startsWith("paused") || t.state === "stalledDL";
    const noSpeed = t.dlspeed === 0;
    const noSeeds = t.num_seeds === 0;
    const noEta = t.eta === 0;
    return pausedOrStalled && noSpeed && noSeeds && noEta;
  });

  // Also handle "app_hard_paused" to give them a second chance daily
  const hardPaused = torrents.filter((t) => {
    return t.tags && t.tags.includes("app_hard_paused");
  });

  const combined = [...deadCandidates, ...hardPaused].filter(
    (v, i, a) => a.findIndex((x) => x.hash === v.hash) === i,
  );

  if (combined.length === 0) {
    logObj.logger.info("[PULSE] No dead or hard-paused torrents to pulse.");
    return;
  }

  const toPulse = combined.slice(0, pulseBatchSize);
  logObj.logger.info(
    `[PULSE] Found ${combined.length} to pulse. Pulsing ${toPulse.length} in this batch.`,
  );

  for (const t of toPulse) {
    try {
      logObj.logger.info(`[PULSE] Resuming torrent: ${t.name}`);
      await resumeTorrent(t.hash);
      logObj.logger.info(`[PULSE] Reannouncing torrent: ${t.name}`);
      await reannounceTorrent(t.hash);
    } catch (err) {
      logObj.logger.error(
        `[PULSE] Error resuming/reannouncing ${t.name}: ${err.message}`,
      );
    }
  }

  const waitMs = pulseDurationMin * 60 * 1000;
  logObj.logger.info(
    `[PULSE] Waiting ${pulseDurationMin} minutes before re-checking...`,
  );
  await delay(waitMs);

  let updated;
  try {
    updated = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(
      `[PULSE] Error fetching torrents after wait: ${err.message}`,
    );
    return;
  }

  let pausedCount = 0;
  for (const t of updated) {
    if (toPulse.find((x) => x.hash === t.hash)) {
      const stillDead = t.dlspeed === 0 && t.num_seeds === 0 && t.eta === 0;
      if (stillDead) {
        logObj.logger.info(
          `[PULSE] Re-pausing torrent still dead after pulse: ${t.name}`,
        );
        try {
          await pauseTorrent(t.hash);
          pausedCount++;
        } catch (err) {
          logObj.logger.error(
            `[PULSE] Error re-pausing ${t.name}: ${err.message}`,
          );
        }
      } else {
        logObj.logger.info(
          `[PULSE] Torrent ${t.name} shows some activity => keep active.`,
        );
      }
    }
  }
  logObj.logger.info(
    `[PULSE] Completed. Re-paused ${pausedCount} torrents still dead after the pulse.`,
  );
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  pulseDeadTorrents,
};
