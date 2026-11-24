# Open-source research

## Milestones 0 and 1

| Project | Findings | Decision |
| --- | --- | --- |
| [OpenList](https://github.com/OpenListTeam/OpenList), [driver template](https://github.com/OpenListTeam/OpenList/blob/main/drivers/template/driver.go) and [local driver](https://github.com/OpenListTeam/OpenList/blob/main/drivers/local/driver.go) | AGPL-3.0 Go project. Drivers combine provider configuration, lifecycle and file operations behind internal driver and object models. The local driver has filesystem-specific features such as thumbnail controls. | Use the architectural idea of distinct provider adapters. Blackbox owns the file tree and assigns opaque object IDs. Independent TypeScript implementation. |
| [rclone](https://github.com/rclone/rclone) | MIT-licensed Go transfer tool with numerous remote backends. An external binary would add subprocess, configuration and credential management. | Reassess individual supported backends in their milestones. |
| [File Browser](https://github.com/filebrowser/filebrowser) | Apache-2.0 application. It focuses on managing a server directory and provides a useful functional reference for uploads and file actions. | Use as a feature reference. A directory-based application would need significant changes for a virtual index and explicit priority routing. |
| [HyperCloud on GitLab](https://gitlab.com/kreuz-com-group/hypercloud) | Related personal cloud project tagged AGPLv3+, WebDAV, TypeScript, React and SQLite. Broader scope includes sync, contacts and calendars. | Reference only. Its broader service architecture would add complexity for the first single-owner milestone. |
| [Fastify](https://github.com/fastify/fastify), [cookie](https://github.com/fastify/fastify-cookie), [rate limit](https://github.com/fastify/fastify-rate-limit) and [static](https://github.com/fastify/fastify-static) | MIT. Provides streamed request bodies, injection-based tests, cookies, bounded request throttling and static delivery. Plugin major versions are matched to Fastify 5. | Adopt compatible major lines. Use a raw binary upload endpoint for one file per request and keep metadata in validated query fields. |
| [node-argon2](https://github.com/ranisalt/node-argon2) and [node-rs](https://github.com/napi-rs/node-rs) | Native Argon2 bindings. node-argon2 is MIT and provides Argon2id with PHC-format hashes and platform prebuilds. node-rs supplies another Argon2 binding with native dependencies. | Use node-argon2. Verify availability on the deployment architecture before deployment. |
| [Node SQLite](https://nodejs.org/docs/latest-v22.x/api/sqlite.html) and [Drizzle](https://github.com/drizzle-team/drizzle-orm) | Node 22 bundles SQLite and the synchronous API. Drizzle (Apache-2.0) adds query builders and schema tooling. | Use Node SQLite with prepared queries and numbered SQL migrations. Keep synchronous transactions short, and keep file I/O outside them. |
| [React](https://github.com/facebook/react), [Vite](https://github.com/vitejs/vite), [Lucide](https://github.com/lucide-icons/lucide), and [Zod](https://github.com/colinhacks/zod) | React and Vite are MIT. Lucide uses ISC with MIT for some original icons. Zod is MIT. Vite 7 supports Node 22.12+. | Use the requested frontend stack and Zod on API boundaries. |

Searches covered GitHub and GitLab for self-hosted file managers, provider abstractions, SQLite and reusable auth components. Cloud OAuth, MEGA, Telegram and TeraBox research belongs to their provider milestones.

## Milestone 2

| Project | Decision |
| --- | --- |
| [tus Node.js server](https://github.com/tus/tus-node-server) and [tus protocol](https://github.com/tus/tus-resumable-upload-protocol) | Adopt the saved-offset model. Blackbox Store uses its existing SQLite index, owner session and encrypted staging with an application-specific transfer API. |
| [restic repository design](https://restic.readthedocs.io/en/stable/design.html) | Follow the design of wrapping a randomly generated storage key with a passphrase-derived key. Reuse Node.js crypto for the AES-GCM envelopes, HKDF and scrypt. |

## Milestone 3

[rclone's Google Drive backend](https://github.com/rclone/rclone/blob/master/docs/content/drive.md) documents application data storage and Desktop OAuth setup. Blackbox Store uses the official Drive API with the same app-data scope, while keeping encrypted object verification and the persistent replica queue in the existing Node and SQLite process. [Google Drive API](https://developers.google.com/workspace/drive/api/guides/appdata)

## Cloud provider follow-up

| Project | Decision |
| --- | --- |
| [rclone MEGA backend](https://rclone.org/mega/) | Reuse its upload, download, and hard-delete support. Use one private RC process to cache the connection and avoid repeated MEGA logins. |
| [Teldrive](https://github.com/tgdrive/teldrive), [GramJS](https://github.com/gram-js/gramjs) and [teleproto](https://github.com/sanyok12345/teleproto) | Use teleproto in the existing Node process and keep message references in SQLite. Telegram's MTProto user session supports channel history and message deletion. Teldrive manages payload parts using PostgreSQL. GramJS is archived and points users to teleproto. |
| [TeraBox OpenAPI](https://www.terabox.com/integrations/docs), [TeraBox CLI reference](https://github.com/terabox-storage/skills/blob/main/terabox-storage/reference/terabox-commands.md) and [OpenList TeraBox driver](https://doc.oplist.org/guide/drivers/terabox) | Use the official OpenAPI for scoped OAuth, private upload, download and active-folder deletion. The owner handles TeraBox Recycle Bin cleanup. |
