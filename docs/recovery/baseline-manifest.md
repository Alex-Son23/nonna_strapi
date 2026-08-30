# Recovered data baseline

The machine-readable baseline is [`baseline-manifest.json`](./baseline-manifest.json). It identifies the preserved SQLite and uploads snapshot independently of aggregate counts, so a replaced record, relation, or file is detectable even when the totals stay unchanged.

## Frozen snapshot identity

- Root commit: `50f9f49723688f36a40d55cfb8333241ef8ccc97`
- `nonna.ru` gitlink commit: `972802f2cabb5e2713f2b0489cbae08e4d2ca6a7`
- SQLite SHA-256: `4046888810c246806b6157f52e264900c994c6113643e6ceb15ca74f8ccd111e`
- SQLite logical last-update timestamp: `2025-06-10T17:54:22.133Z`
- Content: 11 collections, 31 entries, 31 published entries
- Media: 18 database rows, 70 referenced files, 70 physical files
- Reconciliation: no missing referenced upload and no orphan upload

The logical timestamp comes from the newest `updated_at` value in the audited content/media tables. Filesystem mtimes are deliberately excluded from the JSON because copying a preserved snapshot may change them without changing its content.

## Freeze procedure

1. Stop the CMS writer. For the local Compose stack, run `docker compose stop cms` and keep it stopped until both copies have completed.
2. Confirm that `cms/.tmp/data.db-wal`, `cms/.tmp/data.db-shm`, and `cms/.tmp/data.db-journal` do not exist. When `lsof` is available, also confirm that no process has `cms/.tmp/data.db` open for writing.
3. Run the audit against the source snapshot:

   ```sh
   ./scripts/audit-recovery-data.sh \
     --root-commit 50f9f49723688f36a40d55cfb8333241ef8ccc97 \
     --frontend-commit 972802f2cabb5e2713f2b0489cbae08e4d2ca6a7 \
     --compare docs/recovery/baseline-manifest.json \
     --output /tmp/nonna-baseline-verified.json
   ```

4. Create one read-only local copy and one encrypted off-device copy in an independently owned account. Each copy must contain `data.db`, the complete uploads directory, this JSON manifest, and the two commit SHAs above. Preserve the source snapshot; never move it as the only copy.
5. Make the local copy read-only after transfer. The off-device copy must be readable with restore credentials that are not stored on the source computer or VPS.
6. Read both copies back and audit each copy with its explicit `--database` and `--uploads` paths. Compare the generated JSON byte-for-byte with the tracked baseline.

The audit opens SQLite with `mode=ro`, enables query-only access, checks `integrity_check` and `foreign_key_check`, hashes the database before and after inspection, and verifies that the upload set and checksums did not change during inspection. A missing/empty database or SQLite sidecar fails before any database can be created.

## Reproduction and comparison

Run the repository checks from the repository root:

```sh
./scripts/test-docker-recovery.sh data-integrity
./scripts/test-docker-recovery.sh manifest-comparison
```

`data-integrity` reproduces the manifest from the current read-only snapshot and requires an exact match. `manifest-comparison` additionally proves the fail-closed cases on temporary copies: missing/empty SQLite, a missing referenced upload, a non-destructive orphan report, same-count record and relation replacement, and a changed preserved-source checksum.

To verify either preserved copy manually:

```sh
./scripts/audit-recovery-data.sh \
  --database /absolute/path/to/copy/data.db \
  --uploads /absolute/path/to/copy/uploads \
  --root-commit 50f9f49723688f36a40d55cfb8333241ef8ccc97 \
  --frontend-commit 972802f2cabb5e2713f2b0489cbae08e4d2ca6a7 \
  --compare docs/recovery/baseline-manifest.json \
  --output /tmp/nonna-copy-manifest.json
cmp docs/recovery/baseline-manifest.json /tmp/nonna-copy-manifest.json
```

## Git boundary

`cms/.tmp/data.db` and `cms/public/uploads/*` are runtime data and remain ignored. Do not force-add the database, uploads, read-only copies, encrypted archives, credentials, or temporary manifests to Git. Git stores only the audit tooling, documentation, and checksums needed to identify external copies; a clone by itself cannot recover the site data.

Copy locations, encryption recipients, storage-generation identifiers, and restore credential custody are operational evidence and must be recorded in the protected handoff record, not in this repository.
