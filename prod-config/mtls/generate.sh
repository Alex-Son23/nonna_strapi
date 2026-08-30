#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
output_dir=${MTLS_OUTPUT_DIR:-$script_dir/generated}
tools_image=${MTLS_TOOLS_IMAGE:-nonna-mtls-tools:local}

case "$output_dir" in
  /*) ;;
  *) output_dir=$repo_root/$output_dir ;;
esac
mkdir -p "$output_dir"
output_dir=$(CDPATH= cd -- "$output_dir" && pwd)

docker build --tag "$tools_image" "$script_dir"
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env MTLS_OPERATOR_NAME \
  --env MTLS_CA_COMMON_NAME \
  --env MTLS_CA_DAYS \
  --env MTLS_CLIENT_DAYS \
  --mount "type=bind,source=$output_dir,target=/certificates" \
  "$tools_image"
