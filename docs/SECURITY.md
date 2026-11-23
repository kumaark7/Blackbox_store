# Security

First-run setup runs in an interactive server terminal. The intended owner auth uses Argon2id with a unique salt, 19 MiB of memory, two iterations and one lane. Login is throttled across clients. Session IDs are random and only their SHA-256 digests are persisted. Logout revokes the session server-side.

The browser uses HttpOnly and SameSite=Strict cookies, with Secure and the Host cookie prefix for HTTPS. State-changing requests require the configured same-origin Origin header. The local server binds to loopback.

`/login` is the public sign-in page. `/drive` requires a valid owner session and redirects signed-out visitors to `/login`. File listings, downloads and changes also check the owner session on the server. Permanent deletion is available for entries already in the recycle bin.

Virtual names are validated and never used as storage paths. Downloads are authenticated attachments with MIME sniffing disabled. JSON bodies, streamed uploads, concurrent uploads and upload duration are bounded. Create the data directory under an account with appropriate filesystem permissions.

The local milestone stores plaintext. Use test data before encryption and backup recovery are verified. TOTP, secure deployment checks and cloud secret storage belong to later milestones.
