# qbit-node-optimizer

A Node.js application that automates and optimizes the management of your qBittorrent downloads. It monitors torrents via the qBittorrent Web API, automatically handles torrents based on specific criteria, integrates rsync for media transfers, and provides a simple web dashboard for control and visibility.

---

## Features

1. **Dynamic Priority & Management**
   - **Score-Based Priority**
     - The application calculates a "score" for each torrent (e.g., based on age, seed count) to intelligently reorder torrents in the queue.
   - **Near-Completion Boost**
     - Automatically sets torrents at ≥90% completion to top priority for a quick finish.
   - **Slow / Stalled Detection**
     - Identifies torrents with minimal speed or no seeds over a threshold, then pauses them to free bandwidth for faster torrents.
   - **Minimum Active Torrents**
     - Ensures at least a specified number of torrents stay active. If fewer than required are active, it automatically resumes some paused torrents.

2. **Enhanced Tracker Handling**
   - **Fallback Trackers**
     - If *all* trackers fail, adds a predefined fallback list to help "revive" dead torrents.
   - **Extra Trackers**
     - Always attempts to add additional trackers (from a custom environment variable) to improve peer discovery on every torrent.

3. **Auto Re-Announce**
   - Periodically re-announces torrents with broken or stalled trackers to find new peers.

4. **Small Torrent Quick Wins**
   - Detects torrents below a configured size and raises their priority so they finish quickly, freeing up bandwidth.

5. **High-Seed Priority**
   - Specifically prioritizes torrents that have a high number of seeds, ensuring they download rapidly and make maximum use of available bandwidth.

6. **Hard-Paused Torrents**
   - Torrents that show *no* speed, *no* seeds, and *no* ETA can be tagged as "hard paused," excluded from normal auto-unpause.
   - These are only retried once a day (in a "pulse") to see if they can find new peers.

7. **Daily Pulse for Dead Torrents**
   - Once per day, any torrents marked "dead" (including "hard paused") are resumed for a short window to see if seeds become available. If still dead, they’re paused again.

8. **Off-Peak Scheduling**
   - Detects user-defined "off-peak" hours, which you can optionally use to skip certain pausing or throttling logic, or force additional concurrency.

9. **Bandwidth Boost Logic**
   - If total download speed is below a configurable threshold, attempts to *force-resume* additional torrents (up to a limit) to try and better utilize your connection.

10. **Auto-Unpause**
    - If torrents are paused for a certain number of hours (e.g., 4 hours) and are *not* marked "hard paused," they automatically resume.
    - This helps ensure you give torrents multiple chances before fully giving up.

11. **Unregistered Torrent Detection**
    - Checks tracker messages for "unregistered torrent," automatically pausing and tagging them so you can investigate or remove them.

12. **Rsync Integration (Optional)**
    - When your completed folder reaches a configurable size, the app launches an rsync script to transfer data to a remote server (e.g., Plex), then removes local data and the torrent in qBittorrent.
    - Can automatically toggle NordVPN off before rsync and reconnect after.

13. **Web Dashboard**
    - Displays torrent states, speeds, seeds, and categories, and shows logs.
    - Allows manual actions like pause/resume, force-resume, category changes, etc.

14. **Logging & History**
    - Uses Winston for rotating logs, storing a configurable number of days.
    - Maintains a historical record of download speeds and states in a local SQLite database.


---

## Quick Start

1. **Install Dependencies**
```
   npm install
```
2. **Set Environment Variables**
   Create an `.env` file or export variables to the environment.

   Example `.env`:
```
   WEB_BIND_IP=0.0.0.0
   WEB_BIND_PORT=3000
   QB_API_URL=http://localhost:8080
   QB_USERNAME=admin
   QB_PASSWORD=somepassword
   CATEGORY_NAMES="Movies,TV,Music"
```

3. **Start the App**
```
   node src/index.js
```
   or run it in the background (e.g., via PM2 or screen/tmux).

4. **Access the Dashboard**
   Open `http://<your-machine-ip>:3000` in a browser.

---

## License

This project is licensed under the MIT License.
See [LICENSE.md](LICENSE.md) for details.

---
