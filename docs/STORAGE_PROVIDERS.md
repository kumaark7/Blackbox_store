# Storage providers

| Provider | Stage | Intended role |
| --- | --- | --- |
| Local | Milestone 2 implementation | Encrypted local file operations, resumable uploads and recovery. |
| Google Drive | Implemented, account setup required | Verified encrypted copy for Highly Important files, with a local copy retained. |
| MEGA | Implemented, account setup and live test required | Verified encrypted copy for Important files, with a local copy retained. |
| Telegram | Implemented, account setup and live test required | Verified encrypted copy for Backup files in a private broadcast channel, with a local copy retained. |
| TeraBox | Implemented, app approval and live test required | Verified encrypted copy for Backup files, with a local copy retained. Permanent deletion requires owner confirmation of Recycle Bin cleanup. |

The local adapter verifies byte count and SHA-256 before publishing an upload. Its resumable staging file contains encrypted chunks. The recycle bin preserves data until permanent deletion starts. The web app reports local storage usage. Range downloads remain future work.

The importance label is explicit on every upload. A Highly Important item with just the local object is marked degraded. Actual connected cloud quotas determine whether the project reaches its 100 GB capacity target.

Google Drive replication runs in the background and verifies ciphertext before showing a cloud icon. The worker retries from the local copy and reuses the saved remote ID after lost responses. If a verified file is missing or damaged locally, a download can recover and verify it from Google Drive. [Connect Google Drive](GOOGLE_DRIVE_SETUP.md)

MEGA uses the same SQLite queue and recovery path. MEGA does not expose a remote hash through rclone, so the worker reads the ciphertext back to verify the initial copy. MEGA copies are verified on upload and on local recovery. [Connect MEGA](MEGA_SETUP.md)

TeraBox uses the official OpenAPI, the same SQLite queue and ciphertext read-back verification. Copies are verified on upload and local recovery. The owner clears TeraBox's Recycle Bin before Blackbox removes local bytes during permanent deletion. [Connect TeraBox](TERABOX_SETUP.md)

Telegram uses MTProto through the optional teleproto client. A configured private channel receives encrypted documents for Backup files, including files also replicated to TeraBox. Blackbox verifies the ciphertext over Telegram, can use it to repair the local copy, and verifies removal of the channel post before finishing permanent deletion. [Connect Telegram](TELEGRAM_SETUP.md)
