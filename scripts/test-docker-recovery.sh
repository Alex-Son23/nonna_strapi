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

run_empty_entrypoint() {
  empty_root=$test_root/empty-start
  mkdir -p "$empty_root/database" "$empty_root/uploads"
  docker run --rm \
    --mount "type=bind,source=$empty_root/database,target=/opt/app/.tmp" \
    --mount "type=bind,source=$empty_root/uploads,target=/opt/app/public/uploads" \
    "$cms_image" /bin/true
  test ! -e "$empty_root/database/data.db"
  test -z "$(find "$empty_root/uploads" -mindepth 1 -maxdepth 1 -print -quit)"
}

run_generation_entrypoint() {
  generation_root=$1
  generation_id=$2
  docker run --rm \
    --env "RECOVERY_GENERATION_ID=$generation_id" \
    --mount "type=bind,source=$generation_root/database,target=/opt/app/.tmp" \
    --mount "type=bind,source=$generation_root/uploads,target=/opt/app/public/uploads" \
    --mount "type=bind,source=$test_root/seed/data.db,target=/opt/app/seed/data.db,readonly" \
    --mount "type=bind,source=$test_root/seed/uploads,target=/opt/app/seed/uploads,readonly" \
    "$cms_image" /bin/true
}

expect_generation_failure() {
  error_file=$1
  shift
  if "$@" >"$error_file" 2>&1; then
    echo "Generation-managed entrypoint unexpectedly succeeded" >&2
    exit 1
  fi
}

make_generation_target() {
  generation_root="$test_root/$1"
  mkdir -p "$generation_root/database" "$generation_root/uploads"
  printf '%s\n' "$generation_root"
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

  docker run --rm --entrypoint /bin/sh "$cms_image" -c \
    'test ! -e /opt/app/seed/data.db && test ! -e /opt/app/seed/uploads'

  run_empty_entrypoint

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

  printf 'SQLite format 3\000generation-seed\n' > "$test_root/seed/data.db"

  fresh_generation=$(make_generation_target generation-fresh)
  run_generation_entrypoint "$fresh_generation" recovery-v1
  cmp "$test_root/seed/data.db" "$fresh_generation/database/data.db"
  cmp "$test_root/seed/uploads/a.jpg" "$fresh_generation/uploads/a.jpg"
  grep -qx 'recovery-v1' "$fresh_generation/database/.nonna-recovery-generation"
  grep -qx 'recovery-v1' "$fresh_generation/uploads/.nonna-recovery-generation"

  printf 'live-generation-database\n' > "$fresh_generation/database/data.db"
  printf 'live-generation-upload\n' > "$fresh_generation/uploads/a.jpg"
  run_generation_entrypoint "$fresh_generation" recovery-v1
  grep -qx 'live-generation-database' "$fresh_generation/database/data.db"
  grep -qx 'live-generation-upload' "$fresh_generation/uploads/a.jpg"

  mismatched_generation=$(make_generation_target generation-mismatch)
  cp "$test_root/seed/data.db" "$mismatched_generation/database/data.db"
  cp "$test_root/seed/uploads/a.jpg" "$mismatched_generation/uploads/a.jpg"
  printf 'recovery-v1\n' > "$mismatched_generation/database/.nonna-recovery-generation"
  printf 'recovery-v2\n' > "$mismatched_generation/uploads/.nonna-recovery-generation"
  expect_generation_failure "$test_root/generation-mismatch.err" \
    run_generation_entrypoint "$mismatched_generation" recovery-v1
  grep -F 'uploads volume generation marker is missing, malformed, or does not match' \
    "$test_root/generation-mismatch.err" >/dev/null
  cmp "$test_root/seed/data.db" "$mismatched_generation/database/data.db"
  grep -qx 'recovery-v1' "$mismatched_generation/database/.nonna-recovery-generation"
  grep -qx 'recovery-v2' "$mismatched_generation/uploads/.nonna-recovery-generation"

  missing_marker_generation=$(make_generation_target generation-missing-marker)
  cp "$test_root/seed/data.db" "$missing_marker_generation/database/data.db"
  cp "$test_root/seed/uploads/a.jpg" "$missing_marker_generation/uploads/a.jpg"
  printf 'recovery-v1\n' > "$missing_marker_generation/database/.nonna-recovery-generation"
  expect_generation_failure "$test_root/generation-missing-marker.err" \
    run_generation_entrypoint "$missing_marker_generation" recovery-v1
  grep -F 'uploads volume generation marker is missing, malformed, or does not match' \
    "$test_root/generation-missing-marker.err" >/dev/null
  cmp "$test_root/seed/data.db" "$missing_marker_generation/database/data.db"
  test ! -e "$missing_marker_generation/uploads/.nonna-recovery-generation"

  unmarked_generation=$(make_generation_target generation-unmarked)
  cp "$test_root/seed/data.db" "$unmarked_generation/database/data.db"
  cp "$test_root/seed/uploads/a.jpg" "$unmarked_generation/uploads/a.jpg"
  expect_generation_failure "$test_root/generation-unmarked.err" \
    run_generation_entrypoint "$unmarked_generation" recovery-v1
  grep -F 'database volume is nonempty and has no recognized generation marker' \
    "$test_root/generation-unmarked.err" >/dev/null
  cmp "$test_root/seed/data.db" "$unmarked_generation/database/data.db"
  cmp "$test_root/seed/uploads/a.jpg" "$unmarked_generation/uploads/a.jpg"
  test ! -e "$unmarked_generation/database/.nonna-recovery-generation"
  test ! -e "$unmarked_generation/uploads/.nonna-recovery-generation"

  failed_initialization=$(make_generation_target generation-failed-initialization)
  : > "$test_root/seed/data.db"
  expect_generation_failure "$test_root/generation-failed-initialization.err" \
    run_generation_entrypoint "$failed_initialization" recovery-v1
  test ! -e "$failed_initialization/database/.nonna-recovery-generation"
  test ! -e "$failed_initialization/uploads/.nonna-recovery-generation"

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
