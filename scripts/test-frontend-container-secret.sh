#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
frontend_image=${FRONTEND_IMAGE:-nonna-production-frontend-secret-test:local-$$}
secret_volume=nonna-frontend-secret-test-$$
image_created=false
volume_created=false

cleanup() {
  if [ "$volume_created" = true ]; then
    docker volume rm "$secret_volume" >/dev/null 2>&1 || :
  fi
  if [ "$image_created" = true ]; then
    docker image rm "$frontend_image" >/dev/null 2>&1 || :
  fi
}
trap cleanup EXIT HUP INT TERM

if [ -z "${FRONTEND_IMAGE:-}" ]; then
  docker build \
    --tag "$frontend_image" \
    --file "$repo_root/prod-config/Dockerfile.frontend" \
    "$repo_root/nonna.ru"
  image_created=true
fi

docker volume create "$secret_volume" >/dev/null
volume_created=true

docker run --rm \
  --entrypoint /bin/sh \
  --mount "type=volume,source=$secret_volume,target=/fixture" \
  "$frontend_image" \
  -c 'printf "server-only-token\n" > /fixture/api_bearer_token && chown 0:0 /fixture/api_bearer_token && chmod 600 /fixture/api_bearer_token'

fixture_metadata=$(
  docker run --rm \
    --entrypoint /bin/sh \
    --mount "type=volume,source=$secret_volume,target=/fixture,readonly" \
    "$frontend_image" \
    -c "stat -c '%u:%g %a' /fixture/api_bearer_token"
)

[ "$fixture_metadata" = '0:0 600' ] || {
  echo "Secret fixture has unexpected ownership or mode: $fixture_metadata" >&2
  exit 1
}

docker run --rm \
  --user node \
  --entrypoint /bin/sh \
  --env API_BEARER_TOKEN_FILE=/run/secrets/api_bearer_token \
  --mount "type=volume,source=$secret_volume,target=/run/secrets,readonly" \
  "$frontend_image" \
  -c 'test ! -r "$API_BEARER_TOKEN_FILE"'

output=$(
  docker run --rm --read-only \
    --cap-drop ALL \
    --cap-add SETGID \
    --cap-add SETUID \
    --security-opt no-new-privileges:true \
    --env API_BEARER_TOKEN_FILE=/run/secrets/api_bearer_token \
    --mount "type=volume,source=$secret_volume,target=/run/secrets,readonly" \
    "$frontend_image" \
    /bin/sh -c 'cap_eff=$(sed -n "s/^CapEff:[[:space:]]*//p" /proc/self/status); printf "uid=%s token=%s cap_eff=%s\n" "$(id -u)" "$NUXT_API_BEARER_TOKEN" "$cap_eff"'
)

[ "$output" = 'uid=1000 token=server-only-token cap_eff=0000000000000000' ] || {
  echo "Frontend secret test returned unexpected output: $output" >&2
  exit 1
}

echo "Frontend container secret test passed"
