# Connect Telegram for Backup files

Open **Telegram setup instructions** in Account connections for the API ID, channel ID, BotFather token and numeric user ID steps. Telegram replicas and uploads do not contribute to the dashboard’s cloud capacity total.

## Telegram Upload Bot

In **Account connections**, choose **Telegram Upload Bot** and enter a dedicated BotFather token and your own numeric Telegram user ID. The hosted Telegram Bot API connector supports documents up to 20 MB. The bot accepts files only from your private chat with it. Send a document as a file and tap its priority. Blackbox saves the file in **My files** and applies its regular storage rules.

Use a bot with no webhook or other app polling its updates. After connecting, use the link in Blackbox to open the bot and tap **Start**. A priority prompt expires after 15 minutes or if Blackbox Store restarts. Send the document again if its prompt expires.

## Telegram Backup Channel

Blackbox Store can keep a verified encrypted copy of each **Backup** file in a private Telegram broadcast channel you own. The copy uses an opaque filename. If both Telegram and TeraBox are connected, Backup files are copied to both and the encrypted local copy is retained.

Telegram uses an account session through MTProto. The account session lets Blackbox find a post after an interrupted upload and delete older posts. [Telegram history](https://core.telegram.org/method/messages.getHistory) · [Telegram channel deletion](https://core.telegram.org/method/channels.deleteMessages)

## Prepare the account and example file

1. Create a dedicated **private broadcast channel** in Telegram. Keep it private and disable message auto-delete. Send a disposable post and copy its message link. In `https://t.me/c/1234567890/17`, the channel ID is `1234567890`.
2. Get the API ID and API hash at [my.telegram.org](https://my.telegram.org). Use the same Telegram account that owns the channel when signing in.
3. Copy [telegram.example.json](telegram.example.json) to a private directory outside the repository and name it `telegram-connect.json`. Replace all three values when you connect. The channel ID is a JSON string and uses the digits from the link.

The example values are placeholders. Telegram stays disabled until you run the connector successfully.

## Connect from Blackbox Store

Install the MTProto client and set `TELEGRAM_CLIENT_DIR` as shown below. In **Account connections**, select **Telegram** and enter the API ID, API hash and private channel ID. Follow the phone number, login code and two-step verification prompts.

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

1. Upload a small file with **Backup** selected. Wait for its **Telegram** badge, which appears after Blackbox reads back and verifies the encrypted document. Check that the channel shows an opaque `blackbox-*.bbs` document.
2. Download the file from Blackbox and compare it with the original.
3. Move it to the Blackbox Recycle Bin and choose **Delete permanently**. Verify the corresponding Telegram post is gone. If the file also has a TeraBox copy, finish the TeraBox Recycle Bin confirmation when asked.

Each Telegram post can contain up to 2,000,000,000 ciphertext bytes. Blackbox’s default upload limit stays below that. The automated tests simulate the provider. The live connection requires real Telegram credentials and a private channel.
