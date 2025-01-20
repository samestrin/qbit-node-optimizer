/************************************************************
 * File: /qbit-node-optimizer/src/server.js
 *
 * UPDATED:
 * - Added route /forceResume for force resume action.
 * - Normalized states for display, e.g. "stalledDL" => "StallDown".
 * - If peers/avail are missing, show "N/A" in EJS
 *   (we can do that in the EJS or here).
 ************************************************************/
const path = require("path");
const express = require("express");
const bodyParser = require("body-parser");
const db = require("./db");
const { logger, getMemoryLogs } = require("./logger");
const config = require("./config");
const {
  pauseTorrent,
  resumeTorrent,
  forceResumeTorrent,
  getTorrentsInfo,
  setTorrentCategory,
} = require("./qbittorrent");
const { fetchTorrentDetails } = require("./torrentDetails");

const app = express();
app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

/************************************************************
 * Helper function to shorten time
 ************************************************************/
function shortTime(seconds) {
  if (!seconds || seconds < 0) return "-";
  let s = seconds;
  let result = "";
  const days = Math.floor(s / 86400);
  s %= 86400;
  const hrs = Math.floor(s / 3600);
  s %= 3600;
  const mins = Math.floor(s / 60);
  s %= 60;
  if (days > 0) result += days + "d ";
  if (hrs > 0) result += hrs + "h ";
  if (mins > 0) result += mins + "m ";
  if (!days && !hrs && !mins) {
    result += s + "s";
  }
  return result.trim();
}

/************************************************************
 * Helper function to shorten the "state" string
 ************************************************************/
function shortState(orig) {
  if (!orig) return "Unknown";
  const lc = orig.toLowerCase();
  if (lc === "metadl") return "Download Meta";
  if (lc === "checkingdl") return "Checking";
  if (lc === "downloading") return "Download";
  if (lc === "forceddl") return "Download (F)";

  if (lc === "queueddl") return "Queued";
  if (lc === "stalleddl") return "Stalled";

  if (lc === "queuedup") return "Que Up";
  if (lc === "stalledup") return "Stalled Up";

  if (lc.startsWith("paused")) return "Paused";
  // fallback
  return orig;
}

/************************************************************
 * Main page => show non-removed torrents
 ************************************************************/
app.get("/", (req, res) => {
  db.all(
    "SELECT * FROM torrents WHERE state<>'removed' ORDER BY last_updated DESC",
    (err, rows) => {
      if (err) {
        logger.error(`[SERVER] DB Error on /: ${err.message}`);
        return res.status(500).send("DB Error");
      }

      const transformed = rows.map((r) => {
        const newEta = shortTime(r.eta);
        // transform state
        const newState = shortState(r.state);
        return {
          ...r,
          eta: newEta,
          state: newState,
        };
      });
      res.render("index", {
        torrents: transformed,
        categoryList: config.categoryList,
        showRemoved: false,
      });
    },
  );
});

/************************************************************
 * Show removed
 ************************************************************/
app.get("/removed", (req, res) => {
  db.all(
    "SELECT * FROM torrents WHERE state='removed' ORDER BY last_updated DESC",
    (err, rows) => {
      if (err) {
        logger.error(`[SERVER] DB Error on /removed: ${err.message}`);
        return res.status(500).send("DB Error");
      }
      const transformed = rows.map((r) => {
        const newEta = shortTime(r.eta);
        const newState = shortState(r.state);
        return {
          ...r,
          eta: newEta,
          state: newState,
        };
      });
      res.render("index", {
        torrents: transformed,
        categoryList: config.categoryList,
        showRemoved: true,
      });
    },
  );
});

/************************************************************
 * logs => JSON
 ************************************************************/
app.get("/logs", (req, res) => {
  const logs = getMemoryLogs();
  res.json({ logs });
});

/************************************************************
 * Extended info => JSON
 ************************************************************/
app.get("/api/torrents/:hash", async (req, res) => {
  const { hash } = req.params;
  try {
    const details = await fetchTorrentDetails(hash);
    // we could transform state or other fields if we want
    details.state = shortState(details.state);
    res.json(details);
  } catch (err) {
    logger.error(`[SERVER] /api/torrents/:hash error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

/************************************************************
 * Pause / Resume / Force Resume
 ************************************************************/
app.post("/pause", async (req, res) => {
  const { hash } = req.body;
  try {
    await pauseTorrent(hash);
    logger.info(`[SERVER] Manually paused: ${hash}`);
  } catch (error) {
    logger.error(`[SERVER] Pause error: ${error.message}`);
  }
  res.redirect("back");
});

app.post("/resume", async (req, res) => {
  const { hash } = req.body;
  try {
    await resumeTorrent(hash);
    logger.info(`[SERVER] Manually resumed: ${hash}`);
  } catch (error) {
    logger.error(`[SERVER] Resume error: ${error.message}`);
  }
  res.redirect("back");
});

/**
 * Force Resume route
 */
app.post("/forceResume", async (req, res) => {
  const { hash } = req.body;
  if (!hash) {
    return res.status(400).send("Missing hash");
  }
  try {
    await forceResumeTorrent(hash);
    logger.info(`[SERVER] Force resumed torrent: ${hash}`);
  } catch (err) {
    logger.error(`[SERVER] ForceResume error: ${err.message}`);
  }
  res.redirect("back");
});

/************************************************************
 * setCategory => sets category
 ************************************************************/
app.post("/api/setCategory", async (req, res) => {
  const { hash, category } = req.body;
  if (!hash) {
    return res.status(400).json({ error: "Missing hash" });
  }
  try {
    await setTorrentCategory(hash, category || "");
    logger.info(`[SERVER] Category for ${hash} set to '${category}'.`);
    return res.json({ success: true });
  } catch (err) {
    logger.error(`[SERVER] Failed to set category: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

/************************************************************
 * /api/torrents => JSON of all known torrents
 ************************************************************/
app.get("/api/torrents", async (req, res) => {
  try {
    const info = await getTorrentsInfo();
    // could also shorten states or times if desired
    res.json(info);
  } catch (err) {
    logger.error(`[SERVER] /api/torrents error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// New endpoint for triggering re-evaluation
app.post("/api/reevaluate", async (req, res) => {
  try {
    await schedulerLoop(false);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// New endpoint for setting polling frequency
app.post("/api/setPollingInterval", async (req, res) => {
  const { interval } = req.body;
  if (!interval || isNaN(interval)) {
    return res.status(400).json({ error: "Invalid interval value" });
  }

  config.schedulerCron = `*/${parseInt(interval)} * * * *`;
  res.json({ success: true });
});

module.exports = app;
