# qbit-node-optimizer

A Node.js application that automates and optimizes the management of your qBittorrent downloads. It monitors torrents via the qBittorrent Web API, automatically handles torrents based on specific criteria, integrates rsync for media transfers, and provides a simple web dashboard for control and visibility.

---

## Features

- Automated torrent evaluations to pause, resume, and prioritize torrents based on various conditions.
- Integration with rsync for automatic media transfer and cleanup after downloads are complete.
- Optional NordVPN support for managing secure downloads.
- Dead torrent "pulse" mode to periodically recheck and recover stalled torrents.
- Web dashboard for viewing and managing torrents.

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
