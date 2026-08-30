#!/bin/sh
set -eu

app_dir=/opt/app
database_filename="${DATABASE_FILENAME:-.tmp/data.db}"
recovery_generation_id="${RECOVERY_GENERATION_ID:-}"
generation_marker_name=.nonna-recovery-generation

load_secret() {
  secret_name=$1
  secret_file=$2
  [ -n "$secret_file" ] || return 0
  secret_value=$(cat "$secret_file") || {
    echo "Required secret file is not readable: $secret_file" >&2
    exit 1
  }
  [ -n "$secret_value" ] || {
    echo "Required secret file is empty: $secret_file" >&2
    exit 1
  }
  export "$secret_name=$secret_value"
}

load_secret APP_KEYS "${APP_KEYS_FILE:-}"
load_secret API_TOKEN_SALT "${API_TOKEN_SALT_FILE:-}"
load_secret ADMIN_JWT_SECRET "${ADMIN_JWT_SECRET_FILE:-}"
load_secret TRANSFER_TOKEN_SALT "${TRANSFER_TOKEN_SALT_FILE:-}"
load_secret JWT_SECRET "${JWT_SECRET_FILE:-}"

case "$database_filename" in
  /*) database_path="$database_filename" ;;
  *) database_path="$app_dir/$database_filename" ;;
esac

database_dir=$(dirname "$database_path")
uploads_dir="$app_dir/public/uploads"
database_generation_marker="$database_dir/$generation_marker_name"
uploads_generation_marker="$uploads_dir/$generation_marker_name"

mkdir -p "$database_dir" "$uploads_dir"

seed_database="$app_dir/seed/data.db"
seed_uploads="$app_dir/seed/uploads"

fail() {
  echo "Recovery initialization failed: $*" >&2
  exit 1
}

directory_is_empty() {
  [ -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)" ]
}

marker_matches_generation() {
  marker_file=$1
  [ -f "$marker_file" ] || return 1
  marker_lines=$(wc -l < "$marker_file")
  [ "$marker_lines" -eq 1 ] || return 1
  marker_value=$(cat "$marker_file")
  [ "$marker_value" = "$recovery_generation_id" ]
}

seed_upload_files() {
  [ -d "$seed_uploads" ] || fail "recovery uploads seed directory is missing: $seed_uploads"
  for source_file in "$seed_uploads"/*; do
    [ -f "$source_file" ] || continue
    target_file="$uploads_dir/${source_file##*/}"
    if [ ! -e "$target_file" ]; then
      target_temp="${target_file}.seed.tmp"
      rm -f "$target_temp"
      cp "$source_file" "$target_temp"
      chown node:node "$target_temp"
      mv -f "$target_temp" "$target_file"
    fi
  done
}

install_seed_database() {
  database_temp="${database_path}.seed.tmp"
  rm -f "$database_temp"
  cp "$seed_database" "$database_temp"
  chown node:node "$database_temp"
  mv -f "$database_temp" "$database_path"
}

initialize_generation() {
  directory_is_empty "$database_dir" || \
    fail "database volume is nonempty and has no recognized generation marker"
  directory_is_empty "$uploads_dir" || \
    fail "uploads volume is nonempty and has no recognized generation marker"
  [ -s "$seed_database" ] || fail "recovery database seed is missing or empty: $seed_database"
  [ -d "$seed_uploads" ] || fail "recovery uploads seed directory is missing: $seed_uploads"

  echo "Initializing recovery generation $recovery_generation_id"
  install_seed_database
  seed_upload_files
  chown -R node:node "$database_dir" "$uploads_dir"

  database_marker_temp="${database_generation_marker}.tmp.$$"
  uploads_marker_temp="${uploads_generation_marker}.tmp.$$"
  printf '%s\n' "$recovery_generation_id" > "$database_marker_temp"
  printf '%s\n' "$recovery_generation_id" > "$uploads_marker_temp"
  chown node:node "$database_marker_temp" "$uploads_marker_temp"
  mv "$database_marker_temp" "$database_generation_marker"
  mv "$uploads_marker_temp" "$uploads_generation_marker"
}

require_generation() {
  marker_matches_generation "$database_generation_marker" || \
    fail "database volume generation marker is missing, malformed, or does not match RECOVERY_GENERATION_ID"
  marker_matches_generation "$uploads_generation_marker" || \
    fail "uploads volume generation marker is missing, malformed, or does not match RECOVERY_GENERATION_ID"
  [ -s "$database_path" ] || \
    fail "database is missing or empty for recovery generation $recovery_generation_id"
}

if [ -n "$recovery_generation_id" ]; then
  case "$recovery_generation_id" in
    *[!A-Za-z0-9._-]*)
      fail "RECOVERY_GENERATION_ID may contain only letters, digits, dot, underscore, and hyphen"
      ;;
  esac

  if [ -e "$database_generation_marker" ] || [ -e "$uploads_generation_marker" ]; then
    require_generation
  else
    initialize_generation
  fi

  exec su-exec node "$@"
fi

if [ -e "$database_generation_marker" ] || [ -e "$uploads_generation_marker" ]; then
  fail "RECOVERY_GENERATION_ID is required for generation-managed volumes"
fi

if [ ! -s "$database_path" ]; then
  if [ -e "$seed_database" ]; then
    [ -s "$seed_database" ] || fail "recovery database seed is empty: $seed_database"
    echo "Initializing SQLite database from the optional recovery seed"
    install_seed_database
  else
    echo "Starting with an empty SQLite database; Strapi will create the schema"
  fi
fi

if [ -d "$seed_uploads" ]; then
  seed_upload_files
fi

chown -R node:node "$database_dir" "$uploads_dir"

exec su-exec node "$@"
