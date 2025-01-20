# Troubleshooting

Common issues and their solutions:

---

## qBittorrent Not Running

The application checks if qBittorrent is running and attempts to start it if not. Ensure:
- The `qbittorrent` binary is in your system PATH.
- Permissions are set correctly for starting processes.

---

## NordVPN Issues

If `ENABLE_NORDVPN=true`, ensure:
- NordVPN CLI is installed and logged in.
- The `nordvpn` command works correctly from your terminal.

If the application fails to connect or disconnect VPN during rsync, check logs and ensure NordVPN settings are properly configured.

---

## Permission Errors

- Ensure Node.js has write permissions for:
  - Lock files (`SELF_LOCK_FILE`, `RSYNC_LOCK_FILE`).
  - Logs directory (`/logs`).

---

## Rsync Issues

If rsync fails:
- Verify SSH access to the remote server (passwordless login recommended).
- Check `RSYNC_FOLDER` and `RSYNC_SCRIPT` paths in the configuration.

---

## Missing Dependencies

Run the following if modules are missing:
"""
npm install
"""

---

## Logs

Check logs for detailed errors:
- Logs are stored in `/logs` and can also be viewed via the web dashboard.
