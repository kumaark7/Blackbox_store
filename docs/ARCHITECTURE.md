# Architecture

The Fastify API owns authentication and the virtual file tree. SQLite stores virtual names and parents. Storage objects use application-generated identifiers. Moving or renaming an item changes its index record, so future providers need only object operations.

The drive uses one server process and one local adapter. A pending index row reserves the name during an upload. The adapter encrypts chunks before writing them to staging. For resumable uploads it syncs each chunk before committing the new offset in SQLite. Finalization verifies the complete file, publishes the object, and exposes the file in the index. After a restart, an uncommitted staging tail is rewritten from the saved offset. A previously published object is verified again before finalization can complete.

The browser uses same-origin requests. Vite proxies API requests during local development. The built React client can also be served by Fastify. File content is served as a download from an authenticated API route.

Highly Important files are degraded until a Google Drive copy is verified. The Google Drive worker allocates and records a remote ID before sending encrypted bytes. It verifies the stored size and ciphertext checksum before recording success, and periodically checks verified replicas. The server keeps normal reads local and can repair a missing or damaged local object from a previously verified copy. Recycle-bin entries retain their objects until permanent deletion starts. A pending permanent deletion excludes its files from the worker and removes their tracked Google Drive copies before removing local bytes.

Important files use the same replica worker with MEGA. An app-managed rclone process copies opaque encrypted objects over an authenticated loopback control channel. The worker reads each new MEGA replica back and checks its ciphertext hash. It also checks the dedicated folder's binding before transfers or deletion. During permanent deletion, the server removes each file's tracked replicas before removing its local bytes.

Backup files use the replica worker with TeraBox's official OpenAPI. The worker records an opaque path, uploads ciphertext in bounded-size parts and reads it back for SHA-256 verification. The encrypted OAuth credentials are bound to the original application, owner and folder. The permanent-delete route removes the active TeraBox copy and keeps the purge pending until the owner confirms Recycle Bin cleanup.

Telegram runs a separate Backup queue for the same eligible files. Before sending, Blackbox saves an opaque caption and a channel message ID from which to resume the lookup. It can recover the posted message after a lost response and stores the message ID once known. The Telegram session is encrypted and bound to the account and private channel. Before deleting local bytes, the server deletes the tracked post and checks that it is absent.
