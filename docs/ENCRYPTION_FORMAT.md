# Encryption format

Encryption starts in Milestone 2. The format will have a versioned envelope with independently authenticated AES-256-GCM chunks. The design must bind chunk order and identity, ensure nonce uniqueness, and authenticate every chunk before returning its plaintext. File decryption metadata must be recoverable separately from remote object bytes.

The initial model is server-side encryption. The server will handle plaintext during upload and download. File-format and encrypted key-backup decisions must be reviewed and tested before use with real data.
