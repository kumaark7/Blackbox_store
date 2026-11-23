# Recovery

The local drive uses one live process per data directory. On startup it discards any staging or final object associated with a pending reservation, then clears the reservation. A completed local upload has a verified object and committed SQLite metadata.

Permanent deletion records its intent before removing bytes. If it is interrupted, choose **Finish permanent deletion** in the recycle bin. Restore is blocked for that item once deletion begins.

For a manual development backup, stop the server and any setup process. Copy the complete data directory, including SQLite and the object directory. Restore into a separate data directory and verify that the application lists and downloads known test files. Keep local backups private because they contain plaintext files.

Encrypted key backups, manifest export, restore automation and recovery drills are future milestones.
