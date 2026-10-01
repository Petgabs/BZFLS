# Production Security Blueprint

The current School Cloud System is a static public resource library. It is safe for public teaching resources, but client-side login and a browser-unlocked GitHub token are not strong enough for confidential school data.

This blueprint defines the upgrade path for a fully private/identity-aware school cloud.

## Target architecture

1. **School identity provider**
   - Microsoft Entra ID, Google Workspace for Education, or another school SSO.
   - Each teacher and administrator signs in with their own account.

2. **Server-side publishing service**
   - GitHub App or serverless API, never a raw write token in the browser.
   - Teachers may submit files only to staging.
   - Administrators may approve, reject, archive and delete.
   - The service performs all repository writes.

3. **Private object storage when needed**
   - Use Supabase Storage, Azure Blob Storage, S3, Firebase Storage, or equivalent for non-public resources.
   - Public GitHub Pages remains only for approved public learning resources.

4. **Audit log**
   - Record actor, action, resource id/path, timestamp, result, and IP/device metadata where policy permits.
   - Keep audit logs out of browser localStorage; store them server-side.

## Minimal server API contract

| Method | Path | Teacher | Admin | Purpose |
| --- | --- | ---: | ---: | --- |
| `POST` | `/api/submissions` | yes | yes | Upload to staging with metadata. |
| `GET` | `/api/submissions` | own/all by policy | all | List queue entries. |
| `POST` | `/api/submissions/:id/approve` | no | yes | Move file into `apps/`, merge metadata. |
| `POST` | `/api/submissions/:id/reject` | no | yes | Delete staged file and record reason. |
| `DELETE` | `/api/resources/:path` | no | yes | Delete published file and metadata. |
| `GET` | `/api/audit` | no | yes | Review activity log. |

## Required controls

- Per-user authentication and role checks on every server endpoint.
- File type and size validation on the server, not only in the browser.
- Malware scanning if the school uploads Office/PDF files at scale.
- HTML mini-app quarantine or separate sandbox origin.
- Rate limits on upload, approve, reject and delete endpoints.
- Daily backups of metadata, queue and storage.
- Retention policy for deleted resources and audit records.

## Migration path from the current static site

1. Keep the current static library for public resources.
2. Introduce SSO and a serverless `/api/submissions` endpoint.
3. Remove the browser-unlocked GitHub token flow after the server-side publisher is live.
4. Migrate `submissions/queue.json` into a database table.
5. Continue generating `apps.json`/`library.json` for the public GitHub Pages site.
6. Use the Admin Dashboard integrity checker to verify that migrated data matches the deployed files.
