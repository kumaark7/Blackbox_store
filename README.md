# Blackbox Store

A self-hosted personal drive with a unified file tree, importance labels and encrypted local storage.

## Run on Windows

Install a current Node.js 22 LTS release, at least 22.18, with npm. Use PowerShell in the project directory. [Node.js 22 downloads](https://nodejs.org/download/release/latest-v22.x/)

```powershell
node --version
npm install
Copy-Item -LiteralPath .env.example -Destination .env
npm run owner:setup
npm run dev
```

Run the copy command on first setup only. The owner setup prompts in your terminal. Open [http://127.0.0.1:5173](http://127.0.0.1:5173). Sign in, create a folder, upload a test file, and select its importance before starting the upload.

The default data directory is `.data` at the project root. New uploads are encrypted on the server and can be resumed from **Pending uploads** after reselecting the original file. Files uploaded in Milestone 1 remain readable in their original format. Keep the service on loopback while developing.

Stop the server before using the encrypted backup and restore commands. Keep the backup and its recovery passphrase in separate safe places. [Backup and restore commands](docs/RECOVERY.md)

Use **Account connections** to connect or reconnect a provider while Blackbox Store is running. Google Drive uses browser consent, MEGA uses your MEGA login and rclone, TeraBox uses a QR code, and Telegram asks for your phone number and login code. The setup guides cover provider credentials and the existing CMD connectors.

Use **Login management** to see your active sessions, sign out other sessions, or change the owner password. Changing the password ends every session.

Connect Google Drive to add a verified encrypted copy of your **Highly Important** files. [Google Cloud setup and CMD command](docs/GOOGLE_DRIVE_SETUP.md)

Connect MEGA to add a verified encrypted copy of your **Important** files. [MEGA setup and live test](docs/MEGA_SETUP.md)

Connect TeraBox to add a verified encrypted copy of your **Backup** files. [TeraBox setup and live test](docs/TERABOX_SETUP.md)

You can also add Telegram to **Backup**. With both destinations connected, Blackbox copies Backup files to both. [Telegram setup and example credentials](docs/TELEGRAM_SETUP.md)

After sign-in, **Dashboard** shows connected-account capacity, tracked cloud copies, and local disk usage. Hover over the chart or tap a priority to see its file count and size. Open **My files** to manage files or preview a PNG, JPEG, GIF, WebP, or PDF up to 20 MiB. PDFs use your browser's built-in viewer.

## Verify

```powershell
npm test
npm run lint
npm run build
```

The storage-core tests can run without third-party packages using `node --test server/tests/drive.test.ts`. The HTTP tests use temporary local storage and a fixture password. They require installed dependencies.

For a local check of the built UI, run `npm run build`, set `APP_ORIGIN=http://127.0.0.1:4174` in `.env`, then run `npm start` and open [http://127.0.0.1:4174](http://127.0.0.1:4174).

For the browser check, sign in, open **My files**, and upload a test image, PDF, and plain text file. Open both previews and download the text file. Move a disposable copy to the Recycle Bin, return to **Dashboard** to check the change, then restore the copy. Repeat at a narrow viewport before packaging the Android client.

See [development status](DEVELOPMENT_STATUS.md), [architecture](docs/ARCHITECTURE.md) and [API](docs/API.md).
