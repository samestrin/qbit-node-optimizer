/** File: /qbit-node-optimizer/src/scheduler.js ***************************************/

const axios = require("axios");
const db = require("./db");
const logObj = require("./logger");
const config = require("./config");
const {
  getTorrentsInfo,
  getTransferInfo,
  pauseTorrent,
  resumeTorrent,
  forceResumeTorrent,
  topPriority,
  bottomPriority,
  recheckTorrent,
  reannounceTorrent,
  saveTorrentState,
  addTag,
  removeTag,
  addTrackers, // for fallback trackers
} = require("./qbittorrent");

const {
  minLiveTorrents,
  stallThreshold,
  dlTimeOverride,
  slowSpeedThreshold,
  highPrioritySpeed,
  highPriorityPercent,
  autoUnpauseHours,
  maxRecoveryAttempts,
  unregisteredTag,
} = config;

/**
 * Fetch trackers for a given torrent hash
 */
async function fetchTrackers(hash) {
  try {
    const resp = await axios.get(
      `${config.qbApiUrl}/torrents/trackers?hash=${hash}`,
      {
        headers: {
          "Content-Type": "application/json",
          Cookie: config.cookie,
        },
      },
    );
    return resp.data;
  } catch (err) {
    logObj.logger.error(
      `[TRACKERS] Error fetching trackers for ${hash}: ${err.message}`,
    );
    throw err;
  }
}

/**
 * Add a tag to a torrent
 */
async function tagTorrent(hash, tag) {
  try {
    await addTag(hash, tag);
  } catch (error) {
    logObj.logger.error(
      `[TAG] Failed to add tag (${tag}) to ${hash}: ${error.message}`,
    );
  }
}

/**
 * Remove a tag from a torrent
 */
async function untagTorrent(hash, tag) {
  try {
    await removeTag(hash, tag);
  } catch (error) {
    logObj.logger.error(
      `[TAG] Failed to remove tag (${tag}) from ${hash}: ${error.message}`,
    );
  }
}

/**
 * Detect “unregistered” torrents by scanning tracker messages
 */
async function checkUnregisteredTorrents(torrents) {
  for (const t of torrents) {
    let trackers = [];
    try {
      trackers = await fetchTrackers(t.hash);
    } catch (err) {
      // skip if error
      continue;
    }
    const isUnregistered = trackers.some(
      (tr) => tr.msg && tr.msg.toLowerCase().includes("unregistered"),
    );
    if (isUnregistered) {
      const hasWorking = trackers.some((tr) => tr.status === 2);
      if (!hasWorking) {
        logObj.logger.info(
          `[UNREGISTERED] Detected unregistered torrent: ${t.name}. Pausing & tagging.`,
        );
        await pauseTorrent(t.hash);
        await tagTorrent(t.hash, unregisteredTag);
      } else {
        logObj.logger.info(
          `[UNREGISTERED] Torrent ${t.name} unregistered on at least one tracker, but cross-seeding is active.`,
        );
      }
    } else {
      // no unregistered trackers
    }
  }
}

/**
 * Heuristic to determine if a torrent is high-priority
 */
function isHighPriority(t) {
  // forced or sequential download
  const forcedStart = t.force_start === true || t.seq_dl === true;
  if (forcedStart) return true;

  // near completion progress
  const progressPercent = t.progress * 100;
  if (progressPercent >= highPriorityPercent) return true;

  // high actual download speed
  if (t.dlspeed > highPrioritySpeed) return true;

  // short ETA
  if (t.eta > 0 && t.eta < dlTimeOverride) return true;

  return false;
}

/**
 * A torrent is “unconnected” if it has 0 seeds, 0 peers, 0 speed, 0 ETA
 */
function isTorrentUnconnected(t) {
  const noSpeed = t.dlspeed === 0;
  const noSeeds = t.num_seeds === 0;
  const noEta = t.eta === 0;
  return noSpeed && noSeeds && noEta;
}

/**
 * Re-check only paused torrents that appear 100% complete,
 * but do so *only* between midnight and 5 AM.
 */
async function recheckIfInWindow() {
  const now = new Date();
  const hour = now.getHours();
  if (hour >= config.recheckWindowStart && hour < config.recheckWindowEnd) {
    await recheckAndResumeSmallest();
  } else {
    logObj.logger.info(
      `[RECHECK] It's ${hour}h, outside the window ${config.recheckWindowStart}-${config.recheckWindowEnd}; skipping recheck.`,
    );
  }
}

/**
 * Actually do the recheck for paused & completed torrents
 */
async function recheckAndResumeSmallest() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[RECHECK] Can't fetch torrents info: ${err.message}`);
    return;
  }

  const pausedComplete = torrents.filter(
    (t) => t.state.startsWith("paused") && t.progress === 1.0,
  );

  pausedComplete.sort((a, b) => {
    const sizeA = a.size ?? 0;
    const sizeB = b.size ?? 0;
    return sizeA - sizeB;
  });

  for (const p of pausedComplete) {
    try {
      logObj.logger.info(
        `[RECHECK] Force recheck for paused torrent: ${p.name}`,
      );
      await recheckTorrent(p.hash);
    } catch (err) {
      logObj.logger.error(
        `[RECHECK] Error rechecking ${p.name}: ${err.message}`,
      );
    }
  }

  // wait 5s
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // fetch updated info
  let updated;
  try {
    updated = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(
      `[RECHECK] Can't refetch after recheck: ${err.message}`,
    );
    return;
  }

  // resume if still paused but verified complete
  for (const t of updated) {
    if (t.state.startsWith("paused") && t.progress === 1.0) {
      logObj.logger.info(
        `[RECHECK] Torrent ${t.name} completed after recheck. Resuming...`,
      );
      await resumeTorrent(t.hash);
    }
  }
}

/**
 * If trackers for a torrent are all "not working" (status=4), re-announce or add fallback
 */
async function checkAndReannounceProblematic() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[REANNOUNCE] Error fetching torrents: ${err.message}`);
    return;
  }
  for (const t of torrents) {
    let trackers = [];
    try {
      trackers = await fetchTrackers(t.hash);
    } catch (err) {
      // skip
      continue;
    }
    const allNotWorking = trackers.every((tr) => tr.status === 4);
    if (allNotWorking) {
      logObj.logger.info(
        `[REANNOUNCE] All trackers not working for ${t.name}.`,
      );

      // Optionally add fallback trackers if configured
      if (config.fallbackTrackers && config.fallbackTrackers.length > 0) {
        logObj.logger.info(
          `[REANNOUNCE] Adding fallback trackers to ${t.name}...`,
        );
        try {
          await addTrackers(t.hash, config.fallbackTrackers);
        } catch (error) {
          logObj.logger.error(
            `[REANNOUNCE] Failed to add fallback trackers: ${error.message}`,
          );
        }
      }

      // Re-announce after adding trackers
      await reannounceTorrent(t.hash);
    }
  }
}

/**
 * Bump extremely small torrents to top priority so they finish quickly
 */
async function applySmallTorrentQuickWins() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[SMALL_WIN] Error fetching: ${err.message}`);
    return;
  }

  for (const t of torrents) {
    if (
      t.size &&
      t.size < config.smallTorrentMaxSize &&
      !t.state.startsWith("paused")
    ) {
      // Bump it to top prio if it's actively downloading or available
      logObj.logger.info(
        `[SMALL_WIN] Bumping small torrent to top: ${t.name} (${t.size} bytes)`,
      );
      await topPriority(t.hash);
    }
  }
}

/**
 * Heuristic-based priority adjustments
 */
async function applySmartPriority() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[SMARTPRIO] Error fetching: ${err.message}`);
    return;
  }
  const now = Date.now() / 1000;

  for (const t of torrents) {
    const ageSeconds = now - t.added_on;
    const ageDays = ageSeconds / 86400;
    const seeds = t.num_seeds || 0;
    // sample scoring approach
    const score = ageDays * 2 - seeds / 10;

    if (score > 5 && !t.state.startsWith("paused")) {
      logObj.logger.info(
        `[SMARTPRIO] Torrent ${t.name} => top prio (score ${score.toFixed(
          2,
        )}).`,
      );
      await topPriority(t.hash);
    } else if (score < 0 && !t.state.startsWith("paused")) {
      logObj.logger.info(
        `[SMARTPRIO] Torrent ${t.name} => bottom prio (score ${score.toFixed(
          2,
        )}).`,
      );
      await bottomPriority(t.hash);
    }
  }
}

/**
 * If a torrent is removed in qBittorrent, mark it removed in our DB
 */
async function pruneRemovedTorrents(liveHashes) {
  db.all(`SELECT hash FROM torrents`, async (err, rows) => {
    if (err) {
      logObj.logger.error(
        `[SCHEDULER] DB error in pruneRemovedTorrents: ${err.message}`,
      );
      return;
    }
    for (const row of rows) {
      if (!liveHashes.has(row.hash)) {
        // Mark it removed in local DB
        db.run(`UPDATE torrents SET state='removed' WHERE hash=?`, [row.hash]);
      }
    }
  });
}

/**
 * Main scheduler loop
 */
async function schedulerLoop(skipBecauseRsync) {
  if (skipBecauseRsync) {
    logObj.logger.warn(
      "[SCHEDULER] Rsync lock present. Skipping torrent evaluations this run.",
    );
    return;
  }

  let torrents = [];
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[SCHEDULER] getTorrentsInfo error: ${err.message}`);
    return;
  }

  // Keep track of active/known hashes to detect removed torrents
  const liveHashes = new Set(torrents.map((t) => t.hash));

  // Save updated states in DB
  for (const t of torrents) {
    saveTorrentState(t);
  }

  await pruneRemovedTorrents(liveHashes);

  // Check unregistered
  await checkUnregisteredTorrents(torrents);

  // Get global speed
  let transfer;
  try {
    transfer = await getTransferInfo();
  } catch (err) {
    logObj.logger.error(`[SCHEDULER] getTransferInfo error: ${err.message}`);
    transfer = { dl_info_speed: 0 };
  }
  const totalSpeed = transfer.dl_info_speed || 0;
  logObj.logger.info(`[SCHEDULER] Current total speed: ${totalSpeed} B/s`);

  // Evaluate each torrent for stalling, speed, etc.
  for (const t of torrents) {
    // Tag high priority if it meets the heuristic
    if (isHighPriority(t)) {
      await tagTorrent(t.hash, "app_high_priority");
      continue;
    } else {
      await untagTorrent(t.hash, "app_high_priority");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const timeSinceAdded = nowSec - t.added_on;

    // If no seeds/speed/eta after stallThreshold -> pause
    if (isTorrentUnconnected(t) && timeSinceAdded > stallThreshold) {
      logObj.logger.info(
        `[SCHEDULER] Torrent ${t.name} unconnected >${stallThreshold}s. Pausing.`,
      );
      await pauseTorrent(t.hash);
      await markPausedTorrent(t);
      await tagTorrent(t.hash, "app_stalled");
      continue;
    } else {
      await untagTorrent(t.hash, "app_stalled");
    }

    // If slow speed, track it in DB
    if (
      t.dlspeed < slowSpeedThreshold &&
      (t.state === "downloading" || t.state === "stalledDL")
    ) {
      db.run(`UPDATE torrents SET slow_runs = slow_runs + 1 WHERE hash = ?`, [
        t.hash,
      ]);
    } else {
      db.run(`UPDATE torrents SET slow_runs = 0 WHERE hash = ?`, [t.hash]);
    }
  }

  // Pause torrents that have been slow for multiple runs
  db.all(`SELECT * FROM torrents WHERE slow_runs >= 2`, async (err, rows) => {
    if (err) {
      logObj.logger.error(
        `[SCHEDULER] DB error checking slow_runs: ${err.message}`,
      );
      return;
    }
    for (const row of rows) {
      logObj.logger.info(
        `[SCHEDULER] Pausing persistently slow torrent: ${row.name}`,
      );
      await pauseTorrent(row.hash);
      await markPausedTorrent(row);
      db.run(`UPDATE torrents SET slow_runs = 0 WHERE hash = ?`, [row.hash]);
      await tagTorrent(row.hash, "app_persistently_slow");
    }
  });

  // ~~~~~ NEW calls ~~~~~
  // 1) Bump small torrents to top for quick wins
  await applySmallTorrentQuickWins();

  // 2) Only do rechecks if in [midnight..5am]
  await recheckIfInWindow();

  // 3) Re-announce or fix trackers if they're all not working
  await checkAndReannounceProblematic();

  // 4) Smart priority based on age, seeds, etc.
  await applySmartPriority();

  // 5) Near-completion boost
  await applyNearCompletionBoost();

  // 6) Auto-unpause older paused torrents
  await autoUnpauseLongPaused(autoUnpauseHours);

  // 7) Ensure minimum number of active downloads
  await ensureMinimumActiveTorrents();
}

/**
 * Mark torrent as paused in DB with timestamp
 */
async function markPausedTorrent(t) {
  const nowSec = Math.floor(Date.now() / 1000);
  db.run(
    `
    INSERT INTO paused_torrents (hash, name, paused_at)
    VALUES (?, ?, ?)
    ON CONFLICT(hash) DO UPDATE SET paused_at=excluded.paused_at
  `,
    [t.hash, t.name, nowSec],
  );
}

/**
 * Unpause torrents that have been paused for N hours
 */
async function autoUnpauseLongPaused(hours) {
  const cutoff = Math.floor(Date.now() / 1000) - hours * 3600;
  db.all(
    `SELECT * FROM paused_torrents WHERE paused_at < ?`,
    [cutoff],
    async (err, rows) => {
      if (err) {
        logObj.logger.error(`[UNPAUSE] DB error: ${err.message}`);
        return;
      }
      for (const row of rows) {
        try {
          logObj.logger.info(
            `[UNPAUSE] Auto-unpausing after ${hours}h: ${row.name}`,
          );
          await resumeTorrent(row.hash);
          db.run(`DELETE FROM paused_torrents WHERE hash = ?`, [row.hash]);

          await untagTorrent(row.hash, "app_stalled");
          await untagTorrent(row.hash, "app_persistently_slow");
        } catch (error) {
          logObj.logger.error(
            `[UNPAUSE] Failed to unpause ${row.hash}: ${error.message}`,
          );
        }
      }
    },
  );
}

/**
 * Maintain at least minLiveTorrents active (downloading/forcedDL)
 */
async function ensureMinimumActiveTorrents() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[MIN_ACTIVE] getTorrentsInfo error: ${err.message}`);
    return;
  }
  const active = torrents.filter(
    (t) => t.state === "downloading" || t.state === "forcedDL",
  );
  const activeCount = active.length;

  if (activeCount >= minLiveTorrents) {
    logObj.logger.info(
      `[MIN_ACTIVE] ${activeCount} active >= ${minLiveTorrents}. No action.`,
    );
    return;
  }

  const needed = minLiveTorrents - activeCount;
  logObj.logger.info(`[MIN_ACTIVE] Need ${needed} more active torrents.`);

  const paused = torrents.filter((t) => t.state.startsWith("paused"));
  shuffleArray(paused);

  let unpausedCount = 0;
  for (const p of paused) {
    if (unpausedCount >= needed) break;
    const row = await getTorrentRow(p.hash);
    if (row && row.recovery_attempts >= maxRecoveryAttempts) {
      logObj.logger.warn(
        `[MIN_ACTIVE] Skipping ${p.name}, max recover attempts reached.`,
      );
      continue;
    }
    try {
      await resumeTorrent(p.hash);
      logObj.logger.info(`[MIN_ACTIVE] Unpaused: ${p.name}`);
      db.run(
        `UPDATE torrents SET recovery_attempts = recovery_attempts + 1 WHERE hash = ?`,
        [p.hash],
      );
      unpausedCount++;
    } catch (error) {
      logObj.logger.error(
        `[MIN_ACTIVE] Failed to unpause ${p.hash}: ${error.message}`,
      );
    }
  }
}

/**
 * Shuffle an array in-place
 */
function shuffleArray(array) {
  let i = array.length;
  while (i > 0) {
    const j = Math.floor(Math.random() * i);
    i--;
    [array[i], array[j]] = [array[j], array[i]];
  }
}

/**
 * Get one row from torrents table
 */
function getTorrentRow(hash) {
  return new Promise((resolve) => {
    db.get(`SELECT * FROM torrents WHERE hash=?`, [hash], (err, row) => {
      if (err) {
        logObj.logger.error(`[DB] getTorrentRow error: ${err.message}`);
        return resolve(null);
      }
      resolve(row);
    });
  });
}

/**
 * Extra near-completion boost
 */
async function applyNearCompletionBoost() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[BOOST] Error fetching: ${err.message}`);
    return;
  }
  for (const t of torrents) {
    const pct = (t.progress || 0) * 100;
    if (pct >= 90 && !t.state.startsWith("paused")) {
      logObj.logger.info(
        `[BOOST] Near-complete torrent ${t.name} => top priority.`,
      );
      await topPriority(t.hash);
    }
  }
}

module.exports = {
  schedulerLoop,
};
