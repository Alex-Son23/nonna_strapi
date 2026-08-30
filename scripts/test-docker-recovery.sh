#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
mode=${1:-entrypoint}
cms_image="${CMS_IMAGE:-nonna-cms}"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/nonna-recovery-test.XXXXXX")
database="${RECOVERY_DATABASE:-$repo_root/cms/.tmp/data.db}"
uploads="${RECOVERY_UPLOADS:-$repo_root/cms/public/uploads}"
baseline_manifest="${RECOVERY_BASELINE_MANIFEST:-$repo_root/docs/recovery/baseline-manifest.json}"
audit_script="$script_dir/audit-recovery-data.sh"

python_bin=${PYTHON:-}
require_python() {
  [ -z "$python_bin" ] || return 0
  if command -v python3 >/dev/null 2>&1; then
    python_bin=python3
  elif command -v python >/dev/null 2>&1; then
    python_bin=python
  else
    echo "Python 3 is required for recovery tests" >&2
    exit 1
  fi
}

cleanup() {
  chmod -R u+rwX "$test_root" 2>/dev/null || true
  rm -rf "$test_root"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$test_root/database" "$test_root/uploads" "$test_root/seed/uploads"
printf 'SQLite format 3\000seed-v1\n' > "$test_root/seed/data.db"
printf 'seed-upload-a\n' > "$test_root/seed/uploads/a.jpg"

run_entrypoint() {
  docker run --rm \
    --mount "type=bind,source=$test_root/database,target=/opt/app/.tmp" \
    --mount "type=bind,source=$test_root/uploads,target=/opt/app/public/uploads" \
    --mount "type=bind,source=$test_root/seed/data.db,target=/opt/app/seed/data.db,readonly" \
    --mount "type=bind,source=$test_root/seed/uploads,target=/opt/app/seed/uploads,readonly" \
    "$cms_image" /bin/true
}

json_value() {
  "$python_bin" - "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    value = json.load(source)
for part in sys.argv[2].split("."):
    value = value[int(part)] if isinstance(value, list) else value[part]
print(value)
PY
}

assert_manifest_counts() {
  "$python_bin" - "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    manifest = json.load(source)
expected = {
    "collection_count": 11,
    "entry_count": 31,
    "published_entry_count": 31,
    "media_row_count": 18,
    "referenced_upload_count": 70,
    "missing_referenced_upload_count": 0,
}
actual = manifest["summary"]
for key, value in expected.items():
    if actual.get(key) != value:
        raise SystemExit(f"Unexpected {key}: {actual.get(key)!r}, expected {value!r}")
PY
}

audit_with_pinned_release() {
  audit_database=$1
  audit_uploads=$2
  shift 2
  root_commit=$(json_value "$baseline_manifest" release.root_commit_sha)
  frontend_commit=$(json_value "$baseline_manifest" release.frontend_commit_sha)
  "$audit_script" \
    --database "$audit_database" \
    --uploads "$audit_uploads" \
    --root-commit "$root_commit" \
    --frontend-commit "$frontend_commit" \
    "$@"
}

run_entrypoint_tests() {
  docker image inspect "$cms_image" >/dev/null 2>&1 || {
    echo "CMS image not found: $cms_image. Run: docker compose build cms" >&2
    exit 1
  }

  run_entrypoint
  cmp "$test_root/seed/data.db" "$test_root/database/data.db"
  cmp "$test_root/seed/uploads/a.jpg" "$test_root/uploads/a.jpg"

  printf 'live-database\n' > "$test_root/database/data.db"
  printf 'live-upload-a\n' > "$test_root/uploads/a.jpg"
  printf 'seed-upload-b\n' > "$test_root/seed/uploads/b.jpg"
  run_entrypoint
  grep -qx 'live-database' "$test_root/database/data.db"
  grep -qx 'live-upload-a' "$test_root/uploads/a.jpg"
  cmp "$test_root/seed/uploads/b.jpg" "$test_root/uploads/b.jpg"

  printf 'stale-partial-copy\n' > "$test_root/database/data.db.seed.tmp"
  : > "$test_root/database/data.db"
  printf 'SQLite format 3\000seed-v2\n' > "$test_root/seed/data.db"
  run_entrypoint
  cmp "$test_root/seed/data.db" "$test_root/database/data.db"
  test ! -e "$test_root/database/data.db.seed.tmp"

  : > "$test_root/database/data.db"
  : > "$test_root/seed/data.db"
  if run_entrypoint; then
    echo "Entrypoint unexpectedly accepted an empty recovery seed" >&2
    exit 1
  fi

  echo "Docker recovery entrypoint test passed"
}

run_data_integrity_tests() {
  require_python
  [ -f "$baseline_manifest" ] || {
    echo "Baseline manifest is missing: $baseline_manifest" >&2
    exit 1
  }
  current_manifest="$test_root/current-manifest.json"
  audit_with_pinned_release "$database" "$uploads" --output "$current_manifest"
  assert_manifest_counts "$current_manifest"
  cmp "$baseline_manifest" "$current_manifest"
  echo "Recovery data-integrity test passed"
}

make_fixture() {
  fixture="$test_root/$1"
  mkdir -p "$fixture"
  cp -p "$database" "$fixture/data.db"
  cp -R "$uploads" "$fixture/uploads"
  printf '%s\n' "$fixture"
}

mutate_database() {
  "$python_bin" - "$1" "$2" <<'PY'
import sqlite3
import sys

connection = sqlite3.connect(sys.argv[1])
try:
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute(sys.argv[2])
    connection.commit()
finally:
    connection.close()
PY
}

expect_audit_failure() {
  error_file=$1
  shift
  if "$@" >"$test_root/unexpected-manifest.json" 2>"$error_file"; then
    echo "Recovery audit unexpectedly succeeded" >&2
    exit 1
  fi
}

run_manifest_comparison_tests() {
  run_data_integrity_tests

  healthy_fixture=$(make_fixture healthy-copy)
  audit_with_pinned_release "$healthy_fixture/data.db" "$healthy_fixture/uploads" \
    --compare "$baseline_manifest" \
    --output "$test_root/healthy-copy-manifest.json"
  cmp "$baseline_manifest" "$test_root/healthy-copy-manifest.json"

  missing_database="$test_root/missing/data.db"
  mkdir -p "$test_root/missing/uploads"
  expect_audit_failure "$test_root/missing.err" \
    "$audit_script" --database "$missing_database" --uploads "$test_root/missing/uploads"
  grep -F "Recovery database is missing: $missing_database" "$test_root/missing.err" >/dev/null
  test ! -e "$missing_database"

  mkdir -p "$test_root/empty/uploads"
  : > "$test_root/empty/data.db"
  expect_audit_failure "$test_root/empty.err" \
    "$audit_script" --database "$test_root/empty/data.db" --uploads "$test_root/empty/uploads"
  grep -F "Recovery database is empty: $test_root/empty/data.db" "$test_root/empty.err" >/dev/null
  test ! -s "$test_root/empty/data.db"

  missing_upload_fixture=$(make_fixture missing-upload)
  missing_upload=$(json_value "$baseline_manifest" media.0.assets.0.path)
  rm "$missing_upload_fixture/uploads/$missing_upload"
  expect_audit_failure "$test_root/missing-upload.err" \
    audit_with_pinned_release "$missing_upload_fixture/data.db" "$missing_upload_fixture/uploads"
  grep -F "Referenced uploads are missing: $missing_upload" "$test_root/missing-upload.err" >/dev/null
  test ! -e "$missing_upload_fixture/uploads/$missing_upload"

  orphan_fixture=$(make_fixture orphan-upload)
  printf 'orphan upload fixture\n' > "$orphan_fixture/uploads/orphan-test-file.txt"
  audit_with_pinned_release "$orphan_fixture/data.db" "$orphan_fixture/uploads" \
    --output "$test_root/orphan-manifest.json" 2>"$test_root/orphan-upload.err"
  grep -F "Orphan uploads (reported, not deleted): orphan-test-file.txt" "$test_root/orphan-upload.err" >/dev/null
  test -f "$orphan_fixture/uploads/orphan-test-file.txt"
  test "$(json_value "$test_root/orphan-manifest.json" summary.orphan_upload_count)" -eq 1

  record_fixture=$(make_fixture record-replacement)
  mutate_database "$record_fixture/data.db" \
    "UPDATE coatings SET name = name || '-replacement' WHERE id = (SELECT MIN(id) FROM coatings)"
  audit_with_pinned_release "$record_fixture/data.db" "$record_fixture/uploads" \
    --output "$test_root/record-manifest.json"
  assert_manifest_counts "$test_root/record-manifest.json"
  expect_audit_failure "$test_root/record-replacement.err" \
    audit_with_pinned_release "$record_fixture/data.db" "$record_fixture/uploads" \
    --compare "$baseline_manifest"
  grep -F '.entries' "$test_root/record-replacement.err" >/dev/null

  relation_fixture=$(make_fixture relation-replacement)
  mutate_database "$relation_fixture/data.db" \
    "UPDATE parquets_country_links SET country_id = 2 WHERE id = (SELECT MIN(id) FROM parquets_country_links)"
  audit_with_pinned_release "$relation_fixture/data.db" "$relation_fixture/uploads" \
    --output "$test_root/relation-manifest.json"
  assert_manifest_counts "$test_root/relation-manifest.json"
  expect_audit_failure "$test_root/relation-replacement.err" \
    audit_with_pinned_release "$relation_fixture/data.db" "$relation_fixture/uploads" \
    --compare "$baseline_manifest"
  grep -F '.relations' "$test_root/relation-replacement.err" >/dev/null

  checksum_fixture=$(make_fixture source-checksum)
  printf 'preserved-source-checksum-change\n' >> "$checksum_fixture/data.db"
  expect_audit_failure "$test_root/source-checksum.err" \
    audit_with_pinned_release "$checksum_fixture/data.db" "$checksum_fixture/uploads" \
    --compare "$baseline_manifest"
  grep -F '$.database.sha256' "$test_root/source-checksum.err" >/dev/null

  echo "Recovery manifest-comparison test passed"
}

case "$mode" in
  entrypoint)
    run_entrypoint_tests
    ;;
  data-integrity)
    run_data_integrity_tests
    ;;
  manifest-comparison)
    run_manifest_comparison_tests
    ;;
  all)
    run_entrypoint_tests
    run_manifest_comparison_tests
    ;;
  *)
    echo "Usage: $0 [entrypoint|data-integrity|manifest-comparison|all]" >&2
    exit 2
    ;;
esac
