# Development status

## Milestone 0

Initialized the empty Windows project directory as a local Git repository and added an npm workspace, TypeScript configuration, ESLint, Prettier and test commands. Studied OpenList's driver design and compared relevant GitHub and GitLab projects. Selected Fastify, Zod, Node SQLite, node-argon2, React, Vite and Lucide. Dependency installation and the web build have been verified on Node 22.

See [open-source research](docs/OPEN_SOURCE_RESEARCH.md) and [architecture](docs/ARCHITECTURE.md).

## Milestone 1

Implemented the SQLite index and migrations, local streaming object storage, SHA-256 verification, startup cleanup, owner setup and session logic, Fastify file and folder endpoints, and a responsive React file manager. Virtual operations include browsing, search, sorting, folder creation, rename, move, file copy, trash, restore and permanent deletion. The public sign-in page and the authenticated drive have separate routes. Uploads prompt for importance and show transfer progress. Highly Important is degraded while stored as a single copy.

| Area | Files |
| --- | --- |
| Workspace and tooling | Root package, ESLint and environment example, workspace package manifests and TypeScript settings |
| Storage and index | `server/src/storage/`, `server/src/files/`, `server/src/database/` |
| HTTP and authentication | `server/src/api/`, `server/src/auth/`, server startup, configuration and owner setup |
| Web | `apps/web/` |
| Tests | `server/tests/drive.test.ts`, `server/tests/api.test.ts` |

### Verification

- `npm.cmd test` passed all 15 tests on Node 22.23.5. Coverage includes uploads and downloads, authorization, permanent deletion, retry after interruption, and upgrading the prior database schema.
- `npm.cmd run lint` and `npm.cmd run build` passed on Node 22.23.5.
- The built server's route check verified redirects for signed-out visitors and authenticated access to `/drive`. A separate check covered the Vite development guard, including failure to reach the backend.
- Headless Chromium verified login, upload, moving a file to trash, cancelling and confirming permanent deletion, and sign-out through the built app with temporary data and in-process HTTP requests.

### Milestone 1 limits

The first local adapter stored plaintext and discarded partial uploads on restart. Interrupted permanent deletions could be retried from the Recycle bin.

## Milestone 2

New uploads use a versioned, authenticated AES-256-GCM envelope. Existing plaintext objects remain readable. The browser now pauses, resumes and discards pending uploads. SQLite records the last chunk committed to disk, and the complete file is verified before it appears in the drive. The recovery CLI backs up the key, metadata and objects in encrypted form and restores them into a new directory. [Backup and restore](docs/RECOVERY.md)

All 20 automated tests passed on Node 22.23.5. They cover corrupted chunks, missing or replaced keys, legacy database upgrades, overlapping requests, interrupted writes, restart after a publish, and full backup restoration. Lint and the production build passed. An in-process check used the web transfer client with Fastify to pause at 4 MiB, restart, resume and download identical bytes.

## Milestone 3

The Google Drive provider adds a verified encrypted copy of **Highly Important** files and retains the local copy. Its SQLite queue retries after restarts and reuses preallocated Google Drive IDs. The server can repair a missing or corrupt local file from a verified copy. The Desktop OAuth connector stores credentials encrypted and binds the data directory to the original account and client. [Google Drive setup](docs/GOOGLE_DRIVE_SETUP.md)

All 24 automated tests passed, including mock Drive upload, retry, checksum verification, local repair, permanent deletion and credential encryption. Lint and the production build passed. Live Google OAuth and a Drive upload remain to be verified after account setup.

## Milestone 4

Added in-app previews for PNG, JPEG, GIF, WebP and PDF files up to 20 MiB and a local storage panel for application data sizes, Recycle Bin bytes and capacity on the server volume. The web client uses the browser's built-in PDF viewer and offers a download fallback. No third-party viewer is needed.

All 26 automated tests passed, including preview authorization, content validation, downloads, and nested Recycle Bin totals. Lint, type checking, and the production build passed. An in-process run of the web API client against Fastify verified sign-in, preview responses, search, copy, move, trash, restore, and storage usage. Both browser connections timed out reaching the isolated test server, so visual browser verification remains open before the Android client starts.

## Cloud storage follow-up

Added MEGA copies for **Important** files using a private rclone process. MEGA uses the existing replica queue, verifies ciphertext by reading it back, and can repair a missing local copy. The dedicated folder binding guards cloud deletion after restoring a backup or changing rclone configuration. [MEGA setup](docs/MEGA_SETUP.md)

All 29 automated tests passed, along with lint and the production build. The MEGA tests used a mock rclone control API with real encrypted local objects. Live MEGA verification requires rclone and account setup.

Added TeraBox copies for **Backup** files using the official OpenAPI. The connector uses QR authorization and seals account credentials locally. The replica worker verifies ciphertext after upload and can restore a missing local file. Permanent deletion remains pending until the owner clears the matching items from the TeraBox Recycle Bin. [TeraBox setup](docs/TERABOX_SETUP.md)

All 32 automated tests passed, along with lint and the production build. TeraBox tests used real encrypted local objects with simulated provider responses and exercised the permanent-delete confirmation over the authenticated API. Live testing requires approved application credentials and an authorized TeraBox account.

Telegram now has its own **Backup** replica queue. It uses MTProto through an optional teleproto installation. The worker verifies channel copies, recovers lost send responses, and confirms deletion before removing local data. The connector encrypts the Telegram session and binds it to the original account and private channel. [Telegram setup and example credentials](docs/TELEGRAM_SETUP.md)

All 35 automated tests passed, along with lint and the production build. Telegram tests simulated the private channel and covered interrupted uploads, recovery, deletion verification and encrypted credentials. Live Telegram testing requires the MTProto client package and real account credentials.

The Storage dashboard shows reported cloud capacity and verified cloud files by priority in a half-donut. Google Drive, MEGA and TeraBox have quota adapters. Telegram shows tracked replica bytes. Temporary quota failures leave the tracked usage and local disk totals available.

All 37 automated tests passed. A headless Chrome run used simulated account data to verify totals, quota fallback, chart hover, keyboard focus, mobile layout and touch selection. Live quota readings still require connected accounts.
