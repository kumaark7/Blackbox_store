# Local API

API routes use the `/api` prefix. Mutations require the exact configured browser Origin. Protected routes require the owner session cookie. Errors contain an `error` string.

| Method and path | Input and behavior |
| --- | --- |
| GET /health | Basic process liveness. |
| GET /auth/status | Returns setup and session status. |
| POST /auth/login | JSON with `password`. Sets an HttpOnly session cookie after a valid sign-in. |
| POST /auth/logout | Revokes the current session and clears its cookie. |
| GET /entries | Accepts optional `parentId`, `search`, `sort`, `offset`, `limit` or `trash=1`. Returns entries, breadcrumbs and next offset. Search is global across visible entries. |
| POST /folders | JSON with `name` and optional `parentId`. |
| PATCH /entries/:id | JSON with one or more of `name`, `parentId` or `importance`. |
| DELETE /entries/:id | Moves the entry to the recycle bin. |
| POST /entries/:id/restore | Restores an entry under its original parent if the destination name is free. |
| DELETE /entries/:id/permanent | Permanently removes a trashed entry and its stored bytes. For a folder, this includes its entire subtree. An interrupted deletion can be retried from the recycle bin. |
| POST /entries/:id/copy | Copies one file to JSON `name` and optional `parentId` using a distinct storage object. |
| POST /uploads | Sends one binary file as `application/octet-stream`. Query fields are `name`, `importance` and optional `parentId`. Returns 201 after local verification. |
| GET /files/:id/download | Streams the file as an attachment. |

Omitting a destination parent selects the root. Importance values are `highly-important`, `important` and `backup`. The accepted sorts are `name`, `updated` and `size`. The destination name comparison is SQLite's ASCII-insensitive `NOCASE`, with names normalized to NFC.
