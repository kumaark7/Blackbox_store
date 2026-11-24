# Encryption format

New objects use format 1. SQLite records the format, object ID, plaintext size and SHA-256 digest. Format 0 identifies existing plaintext objects. The reader uses the format recorded in SQLite and fails if a format 1 object's envelope cannot be authenticated.

## Format 1

The envelope starts with the 8 ASCII bytes `BBSTORE1`. It then holds consecutive frames for 4 MiB plaintext chunks, with a shorter final chunk when needed. A footer frame contains the 32 raw bytes of the plaintext SHA-256 digest. An empty file contains the header and footer.

Each frame stores a 32-byte random salt, its AES-256-GCM ciphertext, and a 16-byte authentication tag. Its authenticated context is the header, the 36 ASCII bytes of the object ID, the plaintext byte offset as an unsigned 64-bit big-endian integer, the frame plaintext size as an unsigned 32-bit big-endian integer, and a byte for the frame type. The type is 0 for data and 1 for the footer. HKDF-SHA-256 derives a 32-byte frame key from the 32-byte storage key, the frame salt and the context. A fresh salt is generated on every write, including rewrites after a crash. Each derived frame key is used with a 12-byte zero nonce. The footer offset is the file's plaintext size. [Node.js crypto API](https://nodejs.org/download/release/v22.18.0/docs/api/crypto.html)

Downloads validate the footer and expected object length before streaming. They authenticate each frame before releasing its plaintext, and check the full digest against SQLite before releasing the last chunk. A damaged file can cause a download to stop early. Verification at upload completion checks the full file before it appears in the drive.

The data directory contains `storage.key`. SQLite records its SHA-256 fingerprint so a missing or substituted key prevents startup. [Recovery](RECOVERY.md)
