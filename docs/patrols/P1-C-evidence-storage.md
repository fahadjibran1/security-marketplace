# Patrols P1-C — evidence storage, integrity and retention

Status: implemented on `feature/patrols-p1c` (Migration 70, `1720900000016-AddPatrolEvidenceStorage`). Not deployed.
The feature is inert until three things are true: the company's `patrolsEnabled` switch is on, the
`PATROL_EVIDENCE_STORAGE_*` variables point at a private bucket, and the Guard app sends photos (P1-D).

## What it does

| Area | Behaviour |
| --- | --- |
| Storage | Private S3-compatible bucket, separate from the compliance / screening evidence bucket (`EvidenceStorageService` is unchanged). Cloudflare R2 intended. Path-style requests, SigV4 query presigning (`src/patrol/evidence/sigv4.ts`, checked against the AWS published example). |
| Fail closed | No / invalid configuration → every evidence route answers `503 PATROL_EVIDENCE_STORAGE_UNAVAILABLE` **after** the caller's own authorisation. Nothing else in Patrols changes. |
| Keys | `[prefix/]patrol-incoming|patrol|patrol-quarantine|patrol-exports/{companyId}/{yyyy}/{mm}/{uuid v4}[.zip]`. Server-generated only (a client-supplied key is a 400), tenant-scoped, no personal data. |
| Upload | `POST /patrols/runs/:id/evidence` (Guard, own run): declared type (`image/jpeg`, `image/png`, `image/heic`, `image/webp`), size (≤ 10 MiB default) and SHA-256; idempotent on `clientEvidenceId`; returns a presigned PUT (60–300 s, default 120 s) to `patrol-incoming/` with **signed** `Content-Type`, `Content-Length` and `x-amz-checksum-sha256`. |
| Verification | `POST /patrols/evidence/:id/complete`: one verifier at a time (lease); the object is server-side COPIED into `patrol/` (which no client can write) and that copy is streamed through `ImageInspector`: SHA-256, size, magic bytes, full structure walk (JPEG markers + entropy data to the real EOI, PNG chunks to IEND, WebP RIFF length, HEIF boxes), markup scan, dimensions. Mismatch / non-image / polyglot → `rejected` with a reason and the bytes **quarantined** (never silently accepted or dropped). Repeats return the settled result. |
| Viewing | `GET /patrols/evidence/:id/download?purpose=` — `patrols.evidence` (Owner, Admin, Operations, Control Room); presigned GET ≤ 300 s as an attachment of the stored type; every issue audited (`patrol.evidence_accessed`: who, photo, purpose, link expiry — never the URL). Guards cannot download from the server. |
| Retention | 30 days from cloud receipt (90 where the site policy says so, Owner / Admin). `PATROL_EVIDENCE_RETENTION_MODE`: `report` (default — counts and logs only), `enforce`, `off`. |
| Holds | `POST /patrols/holds`, `POST /patrols/holds/:id/release`, `GET /patrols/holds?status=active|all` — `patrols.holds` (Owner / Admin). Scope: photo, run, shift, or site + date range (site-local dates); optional links to an incident, alert or patrol exception (each checked against the company). A hold blocks retention and manual deletion, cancels a pending claim, and blocks the purge of quarantined evidence. Placing and releasing are audited. |
| Deletion | `active → claimed → quarantined (7 days, restorable) → purged → tombstone`. Manual deletion (`POST /patrols/evidence/:id/delete`, Owner / Admin, reason required) uses the same machine. See "State machine" below. |
| Exports | `POST /patrols/exports` (Owner / Admin): run ids or a ≤ 31-day site-local date range (optionally one site), ≤ 500 photos, ≤ 512 MiB, ≤ 2 in flight per company. Built asynchronously and streamed to a ZIP on local disk, then uploaded to `patrol-exports/` for 24 h; `manifest.json`, `manifest.csv` and `manifest.json.sha256` inside; ZIP and manifest SHA-256 recorded; download audited; expiry deletes the object and keeps the record. |
| Metering | `patrol_storage_usage` per (company, site) — active and quarantined objects / bytes — plus a company row for exports; moved in the same transaction as each state change; daily snapshot into `patrol_storage_usage_daily`. `GET /patrols/storage-usage` (Owner / Admin). |
| Maintenance | `PatrolEvidenceMaintenanceService`, every 5 minutes, `SingleFlightJob('patrol-evidence-maintenance')`, per-company session TRY lock `PATROL_EVIDENCE_LOCK_NAMESPACE = 534_401_405`. Steps: verify uploads whose completion never arrived (10 min – 7 days old), retention claims (enforce), quarantine moves, purges (enforce) and retries, export builds and expiry, usage snapshot. |

## State machine (no evidence loss)

```
uploadStatus      pending ─(object found)→ uploaded ─→ verified | rejected(+quarantined)
retentionStatus   active ─claim→ claimed ─move→ quarantined ─purge→ purged ─objects removed→ tombstone
                    ▲               │               │
                    └──── restore ──┴───────────────┘   (Owner / Admin, until the purge)
```

* Every transition is a conditional `UPDATE … WHERE <expected state and token>` committed with its audit entry and usage
  change. Object operations only ever write keys unique to the attempt (completion token, claim token, a fresh restore
  key), and an object is deleted only after the database has committed that it is dead:
  * **move**: copy → verify copy → commit `quarantined` → only then delete the primary (`primaryDeletedAt`). A losing
    racer deletes only its own copy.
  * **purge**: commit `purged` → delete objects → commit `tombstone`. A storage failure leaves `purged` with
    `lastDeletionError` / `deletionAttempts` and is retried next pass. The row is never deleted: a tombstone keeps
    `sha256Stored`, size, receipt / verification / quarantine / purge / removal times.
  * **restore**: copy to a NEW primary key → re-hash against `sha256Stored` → commit `active` → delete the quarantine copy.
* Certified by `scripts/patrol-evidence.spec.ts` (PE-P01 observes the database state at the moment of every storage
  DELETE; PE-P02 injects storage failures).

## Photo previews in the dashboard (issue #79)

* `GET /patrols/runs/:id/evidence/thumbnails?page=&pageSize=` (patrols.evidence; page size default 12, max 24): for one
  page of the run's photos, in the metadata order, the SAME short-lived presigned GET of the stored photo that
  `/patrols/evidence/:id/download` issues, for each photo that rule allows (verified, `active` / `claimed`, key of this
  company); every other photo is listed with `url: null`. ONE audit entry per page view
  (`patrol.evidence_thumbnails_accessed`, entity `patrol_run`, purpose `browse`, the photo ids granted, TTL — never a URL);
  nothing granted, nothing audited. Opening a photo full-size is still `download` with a stated purpose, audited per photo.
* The dashboard draws the links at 56 px with the browser's native lazy loading (`<img loading="lazy">`, no referrer),
  a page at a time, keeps them in memory only and discards them at expiry (asked for again only on request).
* **Why no server-generated thumbnail objects:** the Guard app already re-encodes every photo to JPEG, long edge ≤ 2048 px,
  quality 0.7 (typically a few hundred KB), so a page of 12 lazy-loaded photos is modest. Writing downscaled copies would
  need an image-decoding dependency on the server (a native library parsing untrusted uploads) and a second object per
  photo in every retention, hold, quarantine, purge, restore, metering and export path. Serving the original keeps one
  object per photo: a preview is covered by exactly the photo's retention, holds and deletion, with no migration. If
  photo sizes grow (or HEIC/PNG uploads become common — browsers other than Safari cannot draw HEIC; the tile then says
  "No preview" and the full photo still opens), revisit with stored thumbnails.
* Certified by `scripts/patrol-evidence-thumbnails.spec.ts` (backend) and PM-24–PM-27 in
  `security-mobile-app/scripts/patrol-management-ui.spec.cjs` (dashboard).

## Metadata and privacy

* EXIF / XMP are not parsed. The JPEG walk reads only segment lengths to find the frame header. No location metadata is
  read, stored or acted on (location-based verification is disabled until the DPIA).
* The stored bytes are exactly the bytes the device hashed; the server does not strip metadata (it would change the
  declared SHA-256). **P1-D requirement:** the Guard app must capture without location EXIF (e.g. `exif: false` and no
  location permission for the camera flow) or re-encode before hashing.
* Manifests carry ids (run, visit, checkpoint, site, shift, Guard id), times, hashes and statuses — no Guard name.

## Configuration (all optional; none in code)

| Variable | Meaning |
| --- | --- |
| `PATROL_EVIDENCE_STORAGE_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` (https required, except a localhost test server) |
| `PATROL_EVIDENCE_STORAGE_REGION` | `auto` for R2 (default) |
| `PATROL_EVIDENCE_STORAGE_BUCKET` | a private bucket used only for patrol evidence |
| `PATROL_EVIDENCE_STORAGE_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | an R2 API token scoped to that bucket, Object Read & Write only |
| `PATROL_EVIDENCE_STORAGE_PREFIX` | optional key prefix, e.g. `staging` |
| `PATROL_EVIDENCE_URL_TTL_SECONDS` | 60–300, default 120 |
| `PATROL_EVIDENCE_MAX_BYTES` | 64 KiB–25 MiB, default 10 MiB |
| `PATROL_EVIDENCE_STORAGE_CHECKSUM_HEADER` / `_SIGN_CONTENT_LENGTH` | `false` only if a provider rejects the signed header outright |
| `PATROL_EVIDENCE_RETENTION_MODE` | `report` (default), `enforce`, `off` |

## Provider notes (R2 vs S3 vs MinIO / others)

| Topic | Notes |
| --- | --- |
| Region / addressing | R2 signs with region `auto` and accepts path-style (`/bucket/key`). S3 needs the bucket's real region. |
| ACLs | R2 has no object ACLs; privacy comes from the bucket having no public access / no `r2.dev` URL. Never enable either. |
| Checksums | The upload URL signs `x-amz-checksum-sha256`. AWS S3 and MinIO verify it; **SeaweedFS 3.80 was observed to ignore it** (local run, PSR-2a). R2 must be checked with `npm run test:patrol-evidence-storage` before activation. Whatever the provider does, the server re-hashes the stored copy and rejects a mismatch — the provider check is defence in depth only. |
| Content-MD5 | Not used. |
| Signed Content-Length | Bounds what one URL can upload (abuse protection). Verified on the fake server and SeaweedFS; check on R2 with the script. |
| Presign lifetime | S3 / R2 maximum 7 days; Patrols uses 60–300 s. |
| Response overrides | `response-content-type` / `response-content-disposition` on downloads (attachment). Verified on SeaweedFS and the fake; R2 documents support — check with the script. |
| CORS | Not needed for the native app (no browser). If the web dashboard ever fetches images with `fetch()` (not `<img>` / download link), add a CORS rule on the bucket: origin = the dashboard origin, methods `GET`, `HEAD`. Never `*`. |
| Lifecycle rule | Add a bucket lifecycle rule deleting `patrol-incoming/` objects after **8 days** (longer than the 7-day orphan-recovery horizon) — it removes abandoned or re-PUT incoming objects. Do **not** add lifecycle rules on `patrol/` or `patrol-quarantine/` (retention is the application's). `patrol-exports/` may have a 2-day safety rule. |
| Listing | The token needs no ListBucket; the application never lists. |

## What was exercised (P1-C)

* In-process S3-compatible server (`scripts/fixtures/fake-s3-server.ts`) with its own independent SigV4 verifier, checksum
  enforcement, CopyObject, response overrides and failure injection — the whole HTTP flow in `patrol-evidence.spec.ts`.
* SigV4 signer against the AWS documentation's published example (byte-exact signature).
* `scripts/patrol-evidence-storage-real.spec.ts` against a local SeaweedFS 3.80 (real S3 implementation, Docker,
  localhost only, synthetic credentials): PUT with signed headers, HEAD, streamed GET, CopyObject, idempotent DELETE,
  download overrides, private-bucket refusals all pass; checksum enforcement absent (see above).
* **Not exercised:** Cloudflare R2 and AWS S3 themselves (no credentials were used or needed), and MinIO (its images are
  no longer publicly pullable). Run the real-bucket script against the non-production R2 bucket before activation.

## Before switching on for a pilot company

1. Create the private R2 bucket + scoped token; set the variables on the non-production service; run
   `npm run test:patrol-evidence-storage` against it and record the result (PSR-1 … PSR-6).
2. Add the `patrol-incoming/` lifecycle rule.
3. Keep `PATROL_EVIDENCE_RETENTION_MODE=report` for the first weeks; review the logged counts; then `enforce`.
4. The two pilot-activation follow-ups in `P1-follow-ups.md` (outage reconciliation, exceptional offline recovery).
5. P1-D (Guard app capture without location EXIF; upload + complete with retries).
