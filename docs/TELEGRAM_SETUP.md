# Connect Telegram for Backup files

Open **Telegram setup instructions** in Account connections to keep the guide in a separate tab while configuring Blackbox. Use [@EZ_IDS_Finder_bot](https://t.me/EZ_IDS_Finder_bot) to look up numeric IDs. Keep your bot token, API hash, login codes, and two-step verification password private. Telegram replicas and uploads do not contribute to the dashboard's cloud capacity total.

## Telegram Upload Bot

1. Open [@EZ_IDS_Finder_bot](https://t.me/EZ_IDS_Finder_bot), tap **Start**, and send `/id`. Copy your numeric **User ID**.
2. Open [@BotFather](https://t.me/BotFather) and send `/newbot`. Create a dedicated upload bot and copy its token. Use a bot with no webhook or other app polling its updates.
3. In **Account connections → Telegram Upload Bot**, enter the dedicated bot’s **Bot token** and **Your numeric Telegram user ID**, then click **Connect Telegram Upload Bot**.
4. Open the connected upload bot from Blackbox, tap **Start**, and send a small document as a file. Choose its priority and check **My files** in Blackbox.

The upload bot supports documents up to 20 MB from your private chat with it. A priority prompt expires after 15 minutes or when Blackbox restarts. Send the file again if it expires.

## Telegram Backup Channel

Blackbox Store can keep verified encrypted **Backup** files in a private Telegram broadcast channel you own, using opaque filenames. In cloud-only mode, Blackbox selects TeraBox when connected and uses Telegram when TeraBox is disconnected.

Telegram uses an account session through MTProto. The account session lets Blackbox find a post after an interrupted upload and delete older posts. [Telegram history](https://core.telegram.org/method/messages.getHistory) · [Telegram channel deletion](https://core.telegram.org/method/channels.deleteMessages)

## Prepare the account and example file

1. Create a dedicated **private broadcast channel** in Telegram and disable message auto-delete.
2. In [@EZ_IDS_Finder_bot](https://t.me/EZ_IDS_Finder_bot), tap **Select Channel** and choose your backup channel. If the bot returns an ID such as `-1001234567890`, use `1234567890` in Blackbox. If the channel is missing from the selector or you’re unsure about the ID, copy the link of a test post. In `https://t.me/c/1234567890/17`, use `1234567890`.
3. Sign in at [my.telegram.org](https://my.telegram.org) with the Telegram account that owns your channel. Open **API development tools**, create an app if needed, and copy **API ID** and **API hash**.
4. If you use the Windows CLI below, copy [telegram.example.json](telegram.example.json) to a private directory outside the repository as `telegram-connect.json`. Replace the three example values. Use the API ID as a number and the private channel ID as a quoted string.

## Connect from Blackbox Store

1. Install the MTProto client on the Blackbox server. For the Ubuntu deployment running as `ubuntu`, run:

   ```bash
   npm install --prefix /home/ubuntu/.local/share/blackbox/telegram --save-exact teleproto@1.233.0
   ```

2. Add `TELEGRAM_CLIENT_DIR=/home/ubuntu/.local/share/blackbox/telegram` to the server’s Blackbox `.env`, then run `sudo systemctl restart blackbox-store`. Use the absolute install path for your service account.
3. In **Account connections → Telegram Backup Channel**, enter **API ID**, **API hash**, and **Private channel ID**. Click **Connect Telegram Backup Channel**. Enter your phone number with country code, your Telegram login code, and your two-step verification password if prompted.

## Install and connect from Windows CMD

Stop Blackbox Store with Ctrl+C. Install the MTProto client into its own directory and use the same `.env` and `DATA_DIR` as your Blackbox server.

```cmd
cd /d D:\Projects\blackbox_store
npm install --prefix "%LOCALAPPDATA%\BlackboxStore\telegram" --save-exact teleproto@1.233.0
set "TELEGRAM_CLIENT_DIR=%LOCALAPPDATA%\BlackboxStore\telegram"
npm run telegram:connect -w server -- "%USERPROFILE%\telegram-connect.json"
npm run dev
```

Adjust the JSON path to where you saved the file. Enter your phone number with country code, the Telegram login code and your two-step verification password if prompted. The connector stores the session encrypted in the Blackbox data directory. Keep the API hash, login codes and session private.

For future shells or a service, set `TELEGRAM_CLIENT_DIR` to the expanded absolute install path in the project’s `.env`. If the session is revoked or you restore a Blackbox backup, reconnect the same Telegram account and channel.

## Verify with a disposable file

1. With TeraBox disconnected, upload a small file with **Backup** selected. Wait for its **Telegram** badge, which appears after Blackbox reads back and verifies the encrypted document. Check that the channel shows an opaque `blackbox-*.bbs` document.
2. Download the file from Blackbox and compare it with the original.
3. Move it to the Blackbox Recycle Bin and choose **Delete permanently**. Verify the corresponding Telegram post is gone. If the file also has a TeraBox copy, finish the TeraBox Recycle Bin confirmation when asked.

Each Telegram post can contain up to 2,000,000,000 ciphertext bytes. Blackbox’s default upload limit stays below that. The automated tests simulate the provider. The live connection requires real Telegram credentials and a private channel.
