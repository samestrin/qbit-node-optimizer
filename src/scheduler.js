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
  addTrackers,
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
  smallTorrentMaxSize,
  extraTrackers,
  fallbackTrackers,
  recheckWindowStart,
  recheckWindowEnd,
  offpeakStart,
  offpeakEnd,
  highSeedThreshold,
  bandwidthBoostThreshold,
  maxForcedTorrents,
  maxForcedTorrentsGroup,
} = config;

/**
 * Fetch trackers for a specific torrent to check status messages.
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
    return [];
  }
}

async function tagTorrent(hash, tag) {
  try {
    await addTag(hash, tag);
  } catch (error) {
    logObj.logger.error(
      `[TAG] Failed to add tag (${tag}) to ${hash}: ${error.message}`,
    );
  }
}

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
 * Check if torrent is unregistered (e.g. "Unregistered torrent" message)
 * If so, pause it and tag.
 */
async function checkUnregisteredTorrents(torrents) {
  for (const t of torrents) {
    let trackers = [];
    try {
      trackers = await fetchTrackers(t.hash);
    } catch (err) {
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
      }
    }
  }
}

/**
 * Basic check: forced or near-complete or decent speed => high priority
 */
function isHighPriority(t) {
  const forcedStart = t.force_start === true || t.seq_dl === true;
  if (forcedStart) return true;

  const progressPercent = t.progress * 100;
  if (progressPercent >= highPriorityPercent) return true;
  if (t.dlspeed > highPrioritySpeed) return true;
  if (t.eta > 0 && t.eta < dlTimeOverride) return true;

  return false;
}

/**
 * A torrent is unconnected if it has no speed, no seeds, and no ETA
 */
function isTorrentUnconnected(t) {
  const noSpeed = t.dlspeed === 0;
  const noSeeds = t.num_seeds === 0;
  const noEta = t.eta === 0;
  return noSpeed && noSeeds && noEta;
}

/**
 * Recheck and auto-resume completed-but-paused torrents,
 * but only within certain hours (recheckWindowStart..recheckWindowEnd).
 */
async function recheckIfInWindow() {
  const now = new Date();
  const hour = now.getHours();
  if (hour >= recheckWindowStart && hour < recheckWindowEnd) {
    await recheckAndResumeSmallest();
  } else {
    logObj.logger.info(
      `[RECHECK] It's ${hour}h, outside the window ${recheckWindowStart}-${recheckWindowEnd}; skipping recheck.`,
    );
  }
}

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
    const sizeA = a.size || 0;
    const sizeB = b.size || 0;
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

  // wait a little
  await new Promise((resolve) => setTimeout(resolve, 5000));

  let updated;
  try {
    updated = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(
      `[RECHECK] Can't refetch after recheck: ${err.message}`,
    );
    return;
  }

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
 * If trackers are all not working => re-announce and add fallback + extra trackers.
 * Also ensure we add extra trackers to any torrent missing them.
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
      continue;
    }
    const allNotWorking = trackers.every((tr) => tr.status === 4);
    if (allNotWorking) {
      logObj.logger.info(
        `[REANNOUNCE] All trackers not working for ${t.name}.`,
      );
      const combined = [...fallbackTrackers, ...extraTrackers];
      if (combined.length > 0) {
        logObj.logger.info(
          `[REANNOUNCE] Adding fallback+extra trackers to ${t.name}...`,
        );
        try {
          await addTrackers(t.hash, combined);
        } catch (error) {
          logObj.logger.error(
            `[REANNOUNCE] Failed to add fallback+extra trackers: ${error.message}`,
          );
        }
      }
      await reannounceTorrent(t.hash);
    } else {
      // Ensure extra trackers are present
      if (extraTrackers.length > 0) {
        const existingUrls = trackers.map((tr) => tr.url.trim());
        const missing = extraTrackers.filter(
          (url) => !existingUrls.includes(url),
        );
        if (missing.length > 0) {
          try {
            await addTrackers(t.hash, missing);
            logObj.logger.info(
              `[REANNOUNCE] Added missing extra trackers to ${t.name}.`,
            );
          } catch (err) {
            logObj.logger.error(
              `[REANNOUNCE] Error adding missing trackers to ${t.name}: ${err.message}`,
            );
          }
        }
      }
    }
  }
}

/**
 * Bump small torrents to top priority for quick finishes.
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
      t.size < smallTorrentMaxSize &&
      !t.state.startsWith("paused")
    ) {
      logObj.logger.info(
        `[SMALL_WIN] Bumping small torrent to top: ${t.name} (${t.size} bytes)`,
      );
      await topPriority(t.hash);
    }
  }
}

/**
 * Off-peak detection
 */
function isOffPeak() {
  const hour = new Date().getHours();
  if (offpeakStart < offpeakEnd) {
    return hour >= offpeakStart && hour < offpeakEnd;
  }
  // handle scenario crossing midnight
  return hour >= offpeakStart || hour < offpeakEnd;
}

/**
 * If a torrent has many seeds, optionally bump it.
 */
async function applyHighSeedPriority() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[HIGHSEED] Error fetching: ${err.message}`);
    return;
  }
  for (const t of torrents) {
    if (
      !t.state.startsWith("paused") &&
      t.num_seeds >= highSeedThreshold &&
      t.progress < 1.0
    ) {
      logObj.logger.info(
        `[HIGHSEED] Torrent ${t.name} => top prio (seeds=${t.num_seeds}).`,
      );
      await topPriority(t.hash);
    }
  }
}

/**
 * We keep the original "applySmartPriority()" that uses a score-based approach
 * for older vs. fewer seeds logic. Preserves older feature.
 */
async function applySmartPriority() {
  let torrents;
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(`[SMARTPRIO] Error fetching torrents: ${err.message}`);
    return;
  }
  const now = Math.floor(Date.now() / 1000);

  for (const t of torrents) {
    // original logic from your code:
    const ageSeconds = now - t.added_on;
    const ageDays = ageSeconds / 86400;
    const seeds = t.num_seeds || 0;

    // Example scoring from original code:
    // score = ageDays * 2 - seeds / 10
    const score = ageDays * 2 - seeds / 10;

    if (!t.state.startsWith("paused")) {
      if (score > 5) {
        // top prio
        logObj.logger.info(
          `[SMARTPRIO] Torrent ${t.name} => top prio (score ${score.toFixed(2)}).`,
        );
        await topPriority(t.hash);
      } else if (score < 0) {
        logObj.logger.info(
          `[SMARTPRIO] Torrent ${t.name} => bottom prio (score ${score.toFixed(
            2,
          )}).`,
        );
        await bottomPriority(t.hash);
      }
    }
  }
}

/**
 * Possibly force torrents if total speed is below a threshold and we have capacity for forced torrents.
 */
async function applyBandwidthBoost() {
  // If total speed < bandwidthBoostThreshold, let's force some torrents, up to maxForcedTorrents
  const transfer = await getTransferInfo();
  const currentSpeed = transfer.dl_info_speed || 0;

  if (currentSpeed >= bandwidthBoostThreshold) {
    logObj.logger.info(
      `[BANDWIDTH_BOOST] Current speed >= threshold. No forced action.`,
    );
    return;
  }

  logObj.logger.info(
    `[BANDWIDTH_BOOST] Current speed ${currentSpeed} < threshold ${bandwidthBoostThreshold}. Considering forced start.`,
  );

  let torrents = [];
  try {
    torrents = await getTorrentsInfo();
  } catch (err) {
    logObj.logger.error(
      `[BANDWIDTH_BOOST] getTorrentsInfo error: ${err.message}`,
    );
    return;
  }

  // We'll only try to force if there is room under the max forced limit
  const forced = torrents.filter((t) => t.force_start).length;
  const canForce = maxForcedTorrents - forced;
  if (canForce <= 0) {
    logObj.logger.info(
      `[BANDWIDTH_BOOST] Already at forced torrent limit (${maxForcedTorrents}).`,
    );
    return;
  }

  // If we want to limit how many are forced in a group, we can do so.
  // We can pick a random or sorted approach. We'll do a small group approach:
  let candidates = torrents.filter(
    (t) =>
      !t.force_start && // not already forced
      t.state.startsWith("paused") &&
      t.dlspeed === 0 &&
      t.num_seeds > 0,
  ); // example: paused but has seeds, might do well if forced?

  // limit to maxForcedTorrentsGroup
  candidates = candidates.slice(0, maxForcedTorrentsGroup);
  for (const c of candidates) {
    try {
      logObj.logger.info(`[BANDWIDTH_BOOST] Force-resuming torrent: ${c.name}`);
      await forceResumeTorrent(c.hash);
    } catch (error) {
      logObj.logger.error(
        `[BANDWIDTH_BOOST] Error forcing ${c.name}: ${error.message}`,
      );
    }
  }
}

/**
 * Removes DB references to torrents no longer in the live list.
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
        db.run(`UPDATE torrents SET state='removed' WHERE hash=?`, [row.hash]);
      }
    }
  });
}

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

  const liveHashes = new Set(torrents.map((t) => t.hash));
  for (const t of torrents) {
    saveTorrentState(t);
  }
  await pruneRemovedTorrents(liveHashes);

  await checkUnregisteredTorrents(torrents);

  let transfer;
  try {
    transfer = await getTransferInfo();
  } catch (err) {
    logObj.logger.error(`[SCHEDULER] getTransferInfo error: ${err.message}`);
    transfer = { dl_info_speed: 0 };
  }
  const totalSpeed = transfer.dl_info_speed || 0;
  logObj.logger.info(`[SCHEDULER] Current total speed: ${totalSpeed} B/s`);

  // Check if it's offpeak
  const offPeakNow = isOffPeak();
  if (offPeakNow) {
    logObj.logger.info(
      "[SCHEDULER] Currently off-peak hours. Additional logic can apply.",
    );
    // You could allow more concurrency or skip certain pausing rules, etc.
    // We'll just log it for demonstration.
  }

  // Evaluate stalling or slow torrents
  for (const t of torrents) {
    if (isHighPriority(t)) {
      await tagTorrent(t.hash, "app_high_priority");
      continue; // skip the stall checks below for high-prio torrents
    } else {
      await untagTorrent(t.hash, "app_high_priority");
    }

    const nowSec = Math.floor(Date.now() / 1000);
    const timeSinceAdded = nowSec - t.added_on;

    if (isTorrentUnconnected(t) && timeSinceAdded > stallThreshold) {
      // Hard pause approach
      logObj.logger.info(
        `[SCHEDULER] Torrent ${t.name} unconnected >${stallThreshold}s. Pausing with HARD pause.`,
      );
      await pauseTorrent(t.hash);
      await markPausedTorrent(t);
      await tagTorrent(t.hash, "app_hard_paused");
      continue;
    }

    // If it's just slow, increment slow_runs
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

  // Pause anything with slow_runs >= 2 => app_persistently_slow
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

  // Our "quick wins" for small torrents
  await applySmallTorrentQuickWins();

  // Score-based approach from the original code
  await applySmartPriority();

  // Re-check if we have capacity for forced starts (bandwidth boost logic)
  await applyBandwidthBoost();

  // Recheck in time window
  await recheckIfInWindow();

  // Reannounce problematic & add trackers
  await checkAndReannounceProblematic();

  // Also bump high-seed torrents if not paused
  await applyHighSeedPriority();

  // Near-completion
  await applyNearCompletionBoost();

  // Normal auto-unpause for all but "hard paused"
  await autoUnpauseLongPaused(autoUnpauseHours);

  // Ensure min active torrents
  await ensureMinimumActiveTorrents();
}

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

async function autoUnpauseLongPaused(hours) {
  // Exclude "app_hard_paused" torrents
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
        let torrentInfo;
        try {
          const list = await getTorrentsInfo();
          torrentInfo = list.find((x) => x.hash === row.hash);
        } catch (e) {
          logObj.logger.error(
            `[UNPAUSE] Error fetching torrent info: ${e.message}`,
          );
          continue;
        }
        if (
          torrentInfo &&
          torrentInfo.tags &&
          torrentInfo.tags.includes("app_hard_paused")
        ) {
          // skip
          continue;
        }
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
    if (p.tags && p.tags.includes("app_hard_paused")) {
      logObj.logger.info(
        `[MIN_ACTIVE] Skipping ${p.name} because it is HARD paused.`,
      );
      continue;
    }
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

function shuffleArray(array) {
  let i = array.length;
  while (i > 0) {
    const j = Math.floor(Math.random() * i);
    i--;
    [array[i], array[j]] = [array[j], array[i]];
  }
}

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
