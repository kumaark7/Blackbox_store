# Recovery

The drive uses one process per data directory. **Pending uploads** in the web UI show the last saved offset for resumable uploads. Select **Resume** and choose the original file, or choose **Discard** to release the filename and remove the saved chunks. Interrupted one-request uploads from the older API are cleaned up at startup.

Permanent deletion records its intent before removing bytes. If it is interrupted, choose **Finish permanent deletion** in the recycle bin. Restore is blocked for that item once deletion begins.

## Back up and restore

Stop the server and run these commands from the project directory. Choose existing parent directories and new destination folders separate from the drive. Enter a distinct recovery passphrase when prompted. Store the passphrase separately from the backup.

```powershell
npm.cmd run recovery -w server -- backup "D:\Backups\BlackboxStore-001"
npm.cmd run recovery -w server -- restore "D:\Backups\BlackboxStore-001" "D:\BlackboxStore-Restored"
```

Backups contain a password-protected storage key, an encrypted SQLite snapshot and the encrypted objects. The recovery key file uses scrypt and AES-256-GCM. Pending resumable uploads are included. Existing plaintext objects are encrypted in the backup and stay encrypted in the restored drive. The original drive retains its existing representation. Files already pending permanent deletion are omitted and can be cleared from the restored recycle bin.

The restore verifies the database and completed objects before returning success. It preserves the owner password and clears old sessions. Point `DATA_DIR` in `.env` at the restored directory to start it and sign in again. Open the browser and download a known test file after each recovery drill.

After restoring a drive that used Google Drive, reconnect the original Google account and Desktop OAuth client. The restored database includes replica IDs and the account binding, and reconnecting creates a fresh encrypted credential file. [Reconnect Google Drive](GOOGLE_DRIVE_SETUP.md)

For MEGA, reconnect the original rclone remote and folder. The restored database preserves its binding and object references. [Reconnect MEGA](MEGA_SETUP.md)

For TeraBox, reauthorize the original application and account with the same assigned folder. The restored database preserves its binding and object references. [Reconnect TeraBox](TERABOX_SETUP.md)

For Telegram, authorize the original account and private channel. The restored database preserves its account binding and tracked message IDs. [Reconnect Telegram](TELEGRAM_SETUP.md)

Make an initial backup after starting the Milestone 2 server once. Keep the complete backup outside the project directory. The encrypted backup and its passphrase are both needed to recover after losing the live data directory.
