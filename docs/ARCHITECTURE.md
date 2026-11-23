# Architecture

The Fastify API owns authentication and the virtual file tree. SQLite stores virtual names and parents. Storage objects use application-generated identifiers. Moving or renaming an item changes its index record, so future providers need only object operations.

The first milestone uses one server process and one local adapter. Files stream to a bounded staging file. The adapter verifies the stored size and SHA-256 before the index exposes a completed file. A pending index row reserves the name during an upload. Recycle-bin entries retain the underlying object until permanent lifecycle management is added.

The browser uses same-origin requests. Vite proxies API requests during local development. The built React client can also be served by Fastify. File content is served as a download from an authenticated API route.

The local adapter is an explicit destination for this milestone. Importance is stored for future routing. A Highly Important file has only one local copy and is displayed as degraded. Provider approval, cross-provider replicas, encryption, resumption and remote jobs are introduced in subsequent milestones.
