const db = require("./db");
const logObj = require("./logger");
const {
  getTorrentsInfo,
  pauseTorrent,
  resumeTorrent,
  reannounceTorrent,
} = require("./qbittorrent");
const {
  pulseDurationMin,
  pulseBatchSize,
  stallThreshold,
} = require("./config");

/**
 * We define "dead/unconnected" torrents as those with:
 *  - Paused or stalled with 0 seeds, 0 speed, 0 ETA, or
 *  - Possibly anything we explicitly flagged as 'pulse-failed' in prior runs
 *
 * For simplicity, let's gather "paused" torrents with 0 seeds, 0 speed, 0 ETA.
 *
 * STEPS:
 * 1. Identify up to `pulseBatchSize` "dead" torrents.
 * 2. Resume them all.
 * 3. Force reannounce each to see if new peers appear.
 * 4. Wait `pulseDurationMin` minutes.
 * 5. Re-check them; if they remain at 0 seeds/0 speed => re-pause them.
 */

async function pulseDeadTorrents() {
  logObj.logger.info("[PULSE] Starting dead-torrents pulse...");

  // 1. gather "dead" paused torrents
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[PULSE] Error fetching torrents: ${err.message}`);
    return;
  }

  // define "dead" here:
  const deadCandidates = torrents.filter((t) => {
    const pausedOrStalled =
      t.state.startsWith("paused") || t.state === "stalledDL";
    const noSpeed = t.dlspeed === 0;
    const noSeeds = t.num_seeds === 0;
    const noEta = t.eta === 0;
    return pausedOrStalled && noSpeed && noSeeds && noEta;
  });

  if (deadCandidates.length === 0) {
    logObj.logger.info("[PULSE] No dead torrents found to pulse.");
    return;
  }

  // limit by batch
  const toPulse = deadCandidates.slice(0, pulseBatchSize);
  logObj.logger.info(
    `[PULSE] Found ${deadCandidates.length} dead torrents. Pulsing ${toPulse.length} in this batch.`,
  );

  // 2. resume them & reannounce
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

  // 3. Wait `pulseDurationMin` minutes
  const waitMs = pulseDurationMin * 60 * 1000;
  logObj.logger.info(
    `[PULSE] Waiting ${pulseDurationMin} minutes before re-checking...`,
  );
  await delay(waitMs);

  // 4. Re-check
  let updated;
  try {
    updated = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(
      `[PULSE] Error fetching torrents after wait: ${err.message}`,
    );
    return;
  }

  // 5. If still no seeds, no speed => re-pause
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
          `[PULSE] Torrent ${t.name} shows some activity or seeds => keep active.`,
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
