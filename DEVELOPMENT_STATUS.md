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

### Limits and next work

The local adapter stores plaintext. The current restart behavior discards partial uploads. If a permanent deletion is interrupted, the Recycle bin allows the owner to retry. Previews, quota reporting, remote providers, replica placement, the Android client and resumable transfers remain future work.

Milestone 2 covers encrypted chunks, persistent transfers and tested key recovery.
