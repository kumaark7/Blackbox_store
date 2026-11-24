# Connect MEGA storage

Blackbox Store sends an encrypted copy of each eligible **Important** file to a dedicated MEGA folder. The local copy lets uploads finish while the cloud transfer runs in the background.

## Set up on Windows

With rclone installed on the server, you can enter your MEGA email, password and dedicated folder under **Account connections** in Blackbox Store. Blackbox encrypts the saved connection. When reconnecting, enter the same MEGA account and folder so existing copies stay accessible. The terminal instructions below are for configuring your own rclone remote.

1. Install the current rclone release and confirm `rclone version` works in CMD. Use the same computer and account that run Blackbox Store. [rclone downloads](https://rclone.org/downloads/)
2. Stop Blackbox Store. Run the commands below. In `rclone config`, create a remote named `blackbox-mega` with storage type `mega`, then enter your MEGA login when prompted. Use a private configuration file outside the repository. To use an encrypted rclone configuration, supply its unlock password to rclone through your process environment. [MEGA setup](https://rclone.org/mega/) · [rclone configuration encryption](https://rclone.org/commands/rclone_config_encryption_set/)

```cmd
cd /d D:\Projects\blackbox_store
set "MEGA_RCLONE_CONFIG=%USERPROFILE%\blackbox-rclone.conf"
rclone --config "%MEGA_RCLONE_CONFIG%" config
set "MEGA_RCLONE_REMOTE=blackbox-mega:BlackboxStore"
npm.cmd run mega:connect -w server
```

`mega:connect` checks the configured remote and binds the folder to this data directory. It can create the dedicated folder during first setup. Keep the binding file in that folder. Use `MEGA_RCLONE_EXECUTABLE` to specify the full path to `rclone.exe` if it is outside your `PATH`. For later restarts, set the same variables or put the non-password settings in `.env`.

## Verify with a live file

1. Start Blackbox Store again from the same CMD window. Sign in and upload a small test file as **Important**.
2. Wait for its cloud icon to identify **MEGA**. The replica should appear in the dedicated MEGA folder with an opaque `.bbs` filename. Blackbox Store verifies the ciphertext by reading it back before showing the icon.
3. Download the test file from Blackbox Store and check its contents. For the deletion test, move the disposable test file to the Recycle Bin, then permanently delete it and check that its `.bbs` object is gone from the dedicated MEGA folder.

Blackbox Store starts a private, authenticated loopback rclone process for MEGA. This reuses the MEGA session and uses HTTPS and permanent-delete mode for remote operations. If rclone cannot reach the original folder during deletion, retry from the Recycle Bin after reconnecting. [rclone MEGA backend](https://rclone.org/mega/)

After restoring a backup, use the same rclone remote and run `mega:connect` again with `DATA_DIR` pointing at the restored data directory. The restored database keeps the cloud file references. MEGA credentials remain in the rclone configuration you manage separately.
