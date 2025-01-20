# How It Works

The `qbit-node-optimizer` automates qBittorrent torrent management and includes the following key components:

---

## Main Scheduler

Runs every 5 minutes by default (configurable via `SCHEDULER_CRON`):
- Pauses stalled torrents (e.g., no seeds or speed for a defined time).
- Resumes paused torrents to maintain a minimum number of active downloads.
- Dynamically adjusts priority for torrents nearing completion, small torrents, or older torrents with few seeds.

---

## Rsync Process

Transfers completed torrents to a remote server:
1. Detects if the size of the completed folder exceeds a defined threshold.
2. Temporarily disables NordVPN (if enabled).
3. Executes an rsync script to transfer data to a remote server.
4. Cleans up local files post-transfer and reconnects NordVPN.

---

## Dead Torrents Pulse

Periodically unpauses all "dead" torrents (e.g., stalled or no seeds):
- Keeps them active for a short period to attempt recovery.
- Re-pauses torrents that remain dead.

---

## Web UI

A simple web dashboard for:
- Viewing torrent states, speeds, seeds, and categories.
- Performing manual actions like pause/resume or changing torrent categories.
- Viewing logs and triggering manual re-evaluations.
