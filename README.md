# Blackbox Store

A self-hosted personal drive with a unified file tree and importance labels. The first development release uses a local storage adapter.

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

The default data directory is `.data` at the project root. The app stores local files in plaintext during this milestone. Use test data until encryption and recovery have been verified. Keep the service on loopback while developing.

## Verify

```powershell
npm test
npm run lint
npm run build
```

The storage-core tests can run without third-party packages using `node --test server/tests/drive.test.ts`. The HTTP tests use temporary local storage and a fixture password. They require installed dependencies.

For a local check of the built UI, run `npm run build`, set `APP_ORIGIN=http://127.0.0.1:4174` in `.env`, then run `npm start` and open [http://127.0.0.1:4174](http://127.0.0.1:4174).

See [development status](DEVELOPMENT_STATUS.md), [architecture](docs/ARCHITECTURE.md) and [API](docs/API.md).
