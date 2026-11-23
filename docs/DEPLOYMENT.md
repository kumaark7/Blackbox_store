# Deployment

The current workflow is local and loopback-only. See the [README](../README.md) for development and built-UI checks.

Oracle Ubuntu 24.04 deployment is planned after storage and recovery testing. The intended setup is a dedicated service user, systemd, an Nginx reverse proxy, HTTPS, a fixed data directory, upload-size and timeout settings aligned across the proxy and application, and tested backups.
