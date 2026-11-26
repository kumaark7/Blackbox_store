# Connect Google Drive

Blackbox Store runs locally before you connect Google Drive. After you connect, it adds a verified Google Drive copy of each eligible **Highly Important** file in the background and keeps the encrypted local copy. **Important** and **Backup** stay on local storage at this stage.

## Google Cloud setup

1. Create or select a Google Cloud project and enable the **Google Drive API**. [Enable Google Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com)
2. Open **Google Auth Platform** and complete **Branding**. For a personal Gmail account, select **External** under **Audience**. While the app is in **Testing**, add your own Google account under **Test users**. [Google Auth Platform](https://console.cloud.google.com/auth/overview)
3. Under **Data Access**, add `https://www.googleapis.com/auth/drive.appdata`. This scope grants access to Blackbox Store's hidden application data folder. [Google Drive app data scope](https://developers.google.com/workspace/drive/api/guides/appdata)
4. Open **Clients**, select **Create client**, choose **Desktop app**, and download the OAuth client JSON. Keep it outside the project directory. The connector reads the client ID and client secret from this file and obtains the refresh token during sign-in. [Create OAuth credentials](https://developers.google.com/workspace/guides/create-credentials)

An External app in **Testing** receives refresh tokens that expire after seven days for this scope. Reconnect with the same client and Google account when testing tokens expire. [Google OAuth token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)

## Authorize from Windows CMD

Stop Blackbox Store, then run the following from Command Prompt on the same computer where you will open the sign-in link. Replace the sample JSON path with the downloaded file's actual path.

```cmd
cd /d D:\Projects\blackbox_store
npm.cmd run google-drive:connect -w server -- "%USERPROFILE%\Downloads\client_secret_example.json"
```

Open the URL printed in the terminal and grant access with the account you added as a test user. When the terminal reports success, start the app again with `npm.cmd run dev` and sign in. Upload a small test file as **Highly Important**. Wait for the cloud icon next to its importance label, then download the file and check it still opens. Eligible encrypted files already in Blackbox Store are picked up automatically.

The server stores credentials encrypted in `DATA_DIR`. The encrypted objects are stored under opaque names in Drive's hidden `appDataFolder` and use your account's Drive quota. Browse and download the original files from Blackbox Store. [Google Drive application data folder](https://developers.google.com/workspace/drive/api/guides/appdata)

## Reconnect and recover

Run the same command again with the original Desktop OAuth client and the same Google account. If a retry was waiting, it becomes eligible again at startup. If you restore a Blackbox Store backup into a new data directory, run the connect command with `DATA_DIR` pointing at the restored directory to reopen its Google Drive copies. The backup records Drive file IDs and account binding, while the OAuth credentials are kept in the live data directory.

The worker copies encrypted files only. If you have plaintext files from Milestone 1, you can re-upload them or use the encrypted backup and restore process before replicating them. Already verified copies remain associated with a file if you lower its importance. Permanent deletion removes the Drive copy before removing the local file.

## Browser authorization

For a hosted HTTPS instance, create a **Web application** OAuth client in Google Cloud. Register `APP_ORIGIN` followed by `/api/connections/google/callback` as its authorized redirect URI. In the server's `.env`, set `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, and `GOOGLE_OAUTH_CLIENT_TYPE=web`. Restart Blackbox after editing the server environment.

In **Account connections**, select **Google Drive**, then click **Connect Google Drive**. Sign in and approve access on Google's page. Google returns you to Blackbox, where Google Drive shows **Connected**. An existing replica binding requires the original Google account and OAuth client, which Blackbox reuses for reconnection when saved.

