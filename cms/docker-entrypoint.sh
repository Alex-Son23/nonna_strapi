#!/bin/sh
set -eu

app_dir=/opt/app
database_filename="${DATABASE_FILENAME:-.tmp/data.db}"

load_secret() {
  secret_name=$1
  secret_file=$2
  [ -n "$secret_file" ] || return 0
  [ -r "$secret_file" ] || {
    echo "Required secret file is not readable: $secret_file" >&2
    exit 1
  }
  secret_value=$(cat "$secret_file")
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

mkdir -p "$(dirname "$database_path")" "$app_dir/public/uploads"

seed_database="$app_dir/seed/data.db"

if [ ! -s "$database_path" ]; then
  if [ ! -s "$seed_database" ]; then
    echo "Recovery database seed is missing or empty: $seed_database" >&2
    exit 1
  fi

  echo "Initializing SQLite database from the recovery seed"
  database_temp="${database_path}.seed.tmp"
  rm -f "$database_temp"
  cp "$seed_database" "$database_temp"
  chown node:node "$database_temp"
  mv -f "$database_temp" "$database_path"
fi

if [ -d "$app_dir/seed/uploads" ]; then
  for source_file in "$app_dir"/seed/uploads/*; do
    [ -f "$source_file" ] || continue
    target_file="$app_dir/public/uploads/${source_file##*/}"
    if [ ! -e "$target_file" ]; then
      target_temp="${target_file}.seed.tmp"
      rm -f "$target_temp"
      cp "$source_file" "$target_temp"
      chown node:node "$target_temp"
      mv -f "$target_temp" "$target_file"
    fi
  done
fi

chown -R node:node "$(dirname "$database_path")" "$app_dir/public/uploads"

exec su-exec node "$@"
