# Local API

API routes use the `/api` prefix. Mutations require the exact configured browser Origin. Protected routes require the owner session cookie. Errors contain an `error` string.

| Method and path | Input and behavior |
| --- | --- |
| GET /health | Basic process liveness. |
| GET /auth/status | Returns setup and session status. |
| POST /auth/login | JSON with `password`. Sets an HttpOnly session cookie after a valid sign-in. |
| POST /auth/logout | Revokes the current session and clears its cookie. |
| GET /entries | Accepts optional `parentId`, `search`, `sort`, `offset`, `limit` or `trash=1`. Returns entries, breadcrumbs and next offset. Search is global across visible entries. |
| GET /storage | Returns `googleDrive`, `mega`, `terabox` and `telegram` with states `off`, `connected`, `retrying` or `reconnect`. Entries list verified providers under `cloudCopies`. |
| GET /storage/usage | Returns `appBytes`, `trashBytes`, and `disk` with `totalBytes` and `availableBytes`, or `null` when the server cannot read disk statistics. Also returns `cloud.accounts` and `cloud.priorities`. |
| POST /folders | JSON with `name` and optional `parentId`. |
| PATCH /entries/:id | JSON with one or more of `name`, `parentId` or `importance`. |
| DELETE /entries/:id | Moves the entry to the recycle bin. |
| POST /entries/:id/restore | Restores an entry under its original parent if the destination name is free. |
| DELETE /entries/:id/permanent | Permanently removes a trashed entry and its stored bytes. For a folder, this includes its entire subtree. An interrupted deletion can be retried from the recycle bin. TeraBox copies require the confirmation described below. |
| POST /entries/:id/copy | Copies one file to JSON `name` and optional `parentId` using a distinct storage object. |
| POST /uploads | Sends one binary file as `application/octet-stream`. Query fields are `name`, `importance` and optional `parentId`. Returns 201 after encryption and local verification. |
| GET /transfers | Lists pending uploads with their saved offsets and returns `maxUploadBytes`. |
| POST /transfers | Starts or reopens an upload using JSON `name`, `importance`, `size`, `fingerprint` and optional `parentId`. |
| GET /transfers/:id | Reads a transfer's saved byte count and completion status. |
| PATCH /transfers/:id | Appends a binary chunk with `Content-Type: application/octet-stream` and the current `Upload-Offset` header. Returns the saved progress. |
| POST /transfers/:id/complete | Verifies and publishes a transfer after all bytes arrive. Retrying a completed transfer returns its completed status. |
| DELETE /transfers/:id | Discards a pending transfer and its stored chunks. |
| GET /files/:id/download | Streams the file as an attachment. |
| GET /files/:id/preview | Streams an authenticated PNG, JPEG, GIF, WebP, or PDF for the web preview, up to 20 MiB. Returns `415` for unsupported or mismatched content and `413` for oversized previews. |

Omitting a destination parent selects the root. Importance values are `highly-important`, `important` and `backup`. The accepted sorts are `name`, `updated` and `size`. The destination name comparison is SQLite's ASCII-insensitive `NOCASE`, with names normalized to NFC.

An entry's `preview` is `image`, `pdf`, or `null` based on its name, size and availability. The preview endpoint checks the actual file signature. Storage usage sums the sizes of local data files, including encrypted staging and SQLite. Recycle Bin bytes are part of `appBytes` and include any locally stored files under trashed folders.

Each cloud account includes its `id`, connection `status`, `tracked` replica count and ciphertext bytes, and provider-reported `quota` with `usedBytes` and `totalBytes`. An unavailable quota is `null`, and the total can be `null` when only usage is available. The chart combines accounts that report both values. `cloud.priorities` counts each visible file with a verified copy on a connected account once and sums its original size.

When the permanent-delete route returns `409` with `teraboxCleanup`, it has checked that the listed `paths` are absent from the active TeraBox folder. Ask the owner to clear each matching copy from the TeraBox Recycle Bin. Then retry the request with JSON containing `teraboxConfirmation` set to the returned `teraboxCleanup.confirmation`. The server rechecks the active paths before deleting local data.

Use 4 MiB chunks except for the last chunk, which contains the remaining bytes. The `fingerprint` is the lowercase hex SHA-256 digest of the concatenated raw SHA-256 chunk digests in order. An empty file uses SHA-256 of the empty input and goes straight to completion. Transfers stay hidden from the drive until verification succeeds. After a dropped connection, read `received` before sending another chunk. A stale offset returns `409` and a file fingerprint mismatch at completion returns `422`.
