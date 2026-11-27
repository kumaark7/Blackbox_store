# Connect TeraBox for Backup files

Blackbox Store keeps the encrypted local copy and uploads an encrypted replica of each **Backup** file. It shows the TeraBox badge after reading back the ciphertext and checking its SHA-256. Existing eligible Backup files enter the queue after you connect the account. [TeraBox Open Platform](https://www.terabox.com/integrations) · [TeraBox OpenAPI reference](https://www.terabox.com/integrations/docs)

## Get the application credentials

Apply for an Open Platform application with access to private file operations and device-code authorization. You need its AppKey, SecretKey, PrivateSecret and the exact assigned application folder. Use the full path from TeraBox, including any localized characters.

Save the following as `terabox-connect.json` somewhere private outside the repository. Replace all four example values. Keep the file and its values out of chat and Git.

```json
{
  "clientId": "APP_KEY",
  "clientSecret": "SECRET_KEY",
  "privateSecret": "PRIVATE_SECRET",
  "appFolder": "/From：Other Applications/ASSIGNED_APP_FOLDER"
}
```

## Connect from Blackbox Store

Before the first connection, set `TERABOX_CLIENT_ID` (AppKey), `TERABOX_CLIENT_SECRET` (SecretKey), `TERABOX_PRIVATE_SECRET` (PrivateSecret), and `TERABOX_APP_FOLDER` (the assigned application folder) in the server's `.env`. Restart Blackbox.

In **Account connections**, select **TeraBox**, then choose **Sign in on TeraBox** or **Scan a QR code**. TeraBox handles browser sign-in in its own form. With the QR option, scan the displayed code in TeraBox's mobile app and confirm authorization.

## Connect from Windows CMD

Stop Blackbox Store with Ctrl+C before connecting. The connector uses the same `DATA_DIR` in the project’s `.env` as the server. Run from the project directory with Node.js 22.18 or newer on the Node 22 LTS line.

```cmd
cd /d D:\Projects\blackbox_store
npm run terabox:connect -w server -- "%USERPROFILE%\terabox-connect.json"
```

Adjust the JSON file path to where you saved it. Open the QR image at the path printed in the terminal and scan it from the TeraBox mobile app while signed in to the account you want to use. Confirm access on your phone. The command checks the app folder and stores the credentials encrypted in the data directory. Restart with `npm run dev` or your usual production command.

Blackbox Store refreshes the access token as needed. TeraBox's refresh window expires 30 days after authorization. Run the same command with the original application, account and folder to reauthorize after expiry or after restoring a Blackbox Store backup. [TeraBox OAuth reference](https://www.terabox.com/integrations/docs/hindi)

## Live test

1. Upload a small disposable file and select **Backup**. Wait for the TeraBox badge next to the file. Its provider name is an opaque `blackbox-*.bbs` filename inside the assigned application folder.
2. Download it from Blackbox Store and check that it matches the original.
3. Move the test file to the Blackbox Recycle Bin and choose **Delete permanently**. Blackbox removes the active TeraBox object and shows its exact path. Open the TeraBox Recycle Bin and permanently delete that matching item. Return to Blackbox, check the confirmation box and finish the deletion.

The automated tests use simulated TeraBox responses. Complete these steps with the approved account to verify live compatibility.
