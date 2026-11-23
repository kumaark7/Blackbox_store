# Storage providers

| Provider | Stage | Intended role |
| --- | --- | --- |
| Local | Milestone 1 implementation | Development and local file operations. |
| Google Drive | Planned | Primary for Highly Important, with independent verified redundancy. |
| MEGA | Feasibility and integration pending | Primary for Important. |
| Telegram | Planned | Best-effort Backup storage in an owner-controlled private channel. |
| TeraBox | Feasibility pending | Optional best-effort Backup storage when a supported integration is available. |

The local adapter verifies byte count and SHA-256 before accepting an upload. It supports internal object deletion for failed uploads and can stream complete files. The recycle bin preserves data. Local quota reporting, range downloads and resumable uploads are future work.

The importance label is explicit on every upload. A Highly Important item with just the local object is marked degraded. Actual connected cloud quotas determine whether the project reaches its 100 GB capacity target.
