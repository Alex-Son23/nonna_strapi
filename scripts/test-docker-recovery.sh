#!/bin/sh
set -eu

cms_image="${CMS_IMAGE:-nonna-cms}"
test_root=$(mktemp -d "${TMPDIR:-/tmp}/nonna-recovery-test.XXXXXX")

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
