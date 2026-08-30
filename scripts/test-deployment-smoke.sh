#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
compose_file=$repo_root/prod-config/docker-compose.yml
mode=${1:-configuration}

fail() {
  echo "deployment smoke failed: $*" >&2
  exit 1
}

require_pattern() {
  pattern=$1
  file=$2
  grep -E "$pattern" "$file" >/dev/null || fail "$file is missing required pattern: $pattern"
}

run_configuration() {
  command -v docker >/dev/null || fail "docker is required for Compose validation"
  command -v python3 >/dev/null || fail "python3 is required for resolved topology validation"

  test_root=$(mktemp -d "${TMPDIR:-/tmp}/nonna-deployment-smoke.XXXXXX")
  trap 'rm -rf "$test_root"' EXIT HUP INT TERM
  mkdir -p "$test_root/uploads" "$test_root/certbot/active" "$test_root/certbot-webroot"
  printf 'sqlite-placeholder\n' > "$test_root/data.db"
  printf 'allow 127.0.0.1;\nallow ::1;\ndeny all;\n' > "$test_root/admin-allowlist.conf"

  for secret in app-keys api-token-salt admin-jwt transfer-token jwt api-token; do
    printf 'configuration-test-%s\n' "$secret" > "$test_root/$secret"
  done
  printf 'operator:{PLAIN}configuration-test-only\n' > "$test_root/admin.htpasswd"

  env_file=$test_root/production.env
  {
    printf 'COMPOSE_PROJECT_NAME=nonna-configuration-test\n'
    printf 'DOMAIN=example.test\n'
    printf 'ADMIN_DOMAIN=admin.example.test\n'
    printf 'PUBLIC_BIND_ADDRESS=127.0.0.1\n'
    printf 'CMS_SEED_DATABASE=%s/data.db\n' "$test_root"
    printf 'CMS_SEED_UPLOADS=%s/uploads\n' "$test_root"
    printf 'CERTBOT_STATE_DIR=%s/certbot\n' "$test_root"
    printf 'CERTBOT_WEBROOT_DIR=%s/certbot-webroot\n' "$test_root"
    printf 'ADMIN_ALLOWLIST_FILE=%s/admin-allowlist.conf\n' "$test_root"
    printf 'APP_KEYS_FILE=%s/app-keys\n' "$test_root"
    printf 'API_TOKEN_SALT_FILE=%s/api-token-salt\n' "$test_root"
    printf 'ADMIN_JWT_SECRET_FILE=%s/admin-jwt\n' "$test_root"
    printf 'TRANSFER_TOKEN_SALT_FILE=%s/transfer-token\n' "$test_root"
    printf 'JWT_SECRET_FILE=%s/jwt\n' "$test_root"
    printf 'API_BEARER_TOKEN_FILE=%s/api-token\n' "$test_root"
    printf 'ADMIN_HTPASSWD_FILE=%s/admin.htpasswd\n' "$test_root"
  } > "$env_file"

  resolved=$test_root/compose.json
  docker compose --env-file "$env_file" -f "$compose_file" config --format json > "$resolved"

  python3 - "$resolved" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as stream:
    config = json.load(stream)

services = config["services"]
expected = {"cms", "frontend", "nginx", "certbot"}
assert set(services) == expected, set(services)

for name in ("cms", "frontend", "certbot"):
    assert not services[name].get("ports"), f"{name} unexpectedly publishes ports"

ports = services["nginx"].get("ports", [])
assert sorted(port["target"] for port in ports) == [80, 443], ports
assert config["networks"]["backend"].get("internal") is True
assert services["certbot"]["image"] == "certbot/certbot:v5.7.0"
assert services["nginx"]["image"] == "nginx:1.27-alpine"

for name in expected:
    assert services[name].get("read_only") is True, f"{name} rootfs is writable"
    assert "no-new-privileges:true" in services[name].get("security_opt", [])

frontend_environment = services["frontend"]["environment"]
assert "API_BEARER_TOKEN" not in frontend_environment
assert frontend_environment["API_BEARER_TOKEN_FILE"] == "/run/secrets/api_bearer_token"
assert frontend_environment["NUXT_API_PROXY_TARGET"] == "http://cms:1337"
assert frontend_environment["NUXT_PUBLIC_API_BASE"] == "/api"
assert frontend_environment["NUXT_PUBLIC_URL"] == "https://example.test"
PY

  frontend_secret=$test_root/frontend-api-token
  printf 'server-only-token\n' > "$frontend_secret"
  loaded_token=$(
    API_BEARER_TOKEN_FILE=$frontend_secret \
      "$repo_root/nonna.ru/docker-entrypoint.sh" \
      /bin/sh -c 'printf %s "$NUXT_API_BEARER_TOKEN"'
  )
  [ "$loaded_token" = "server-only-token" ] || \
    fail "frontend entrypoint did not expose the token through Nuxt runtime config"

  nginx_config=$repo_root/prod-config/nginx.conf
  require_pattern 'rate=10r/s' "$nginx_config"
  require_pattern 'burst=20' "$nginx_config"
  require_pattern 'limit_conn public_api_connections 20' "$nginx_config"
  require_pattern 'limit_(req|conn)_status 429' "$nginx_config"
  require_pattern 'proxy_read_timeout 15s' "$nginx_config"
  require_pattern 'auth_basic_user_file /run/secrets/admin_htpasswd' "$nginx_config"
  require_pattern 'include /etc/nginx/admin-allowlist.conf' "$nginx_config"
  require_pattern 'client_max_body_size 15m' "$nginx_config"
  require_pattern 'location \^~ /uploads/' "$nginx_config"
  require_pattern 'content-manager\|content-type-builder\|upload\|users-permissions' "$nginx_config"
  require_pattern 'return 308 https://\$host\$request_uri' "$nginx_config"

  node --test "$repo_root/nonna.ru/server/utils/api-contract.test.mjs"
  node --test "$repo_root/nonna.ru/utils/sanitize-cms-html.test.mjs"
  node --test \
    "$repo_root/cms/src/middlewares/validate-upload.test.js" \
    "$repo_root/cms/src/security/assert-public-role-empty.test.js"
  sh -n "$repo_root/prod-config/certbot/bootstrap.sh"
  sh -n "$repo_root/prod-config/certbot/renew.sh"

  echo "Production configuration smoke passed"
}

status_for() {
  method=$1
  url=$2
  shift 2
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --request "$method" "$@" "$url"
}

expect_status() {
  expected=$1
  method=$2
  url=$3
  shift 3
  actual=$(status_for "$method" "$url" "$@")
  [ "$actual" = "$expected" ] || fail "$method $url returned $actual, expected $expected"
}

run_runtime() {
  command -v curl >/dev/null || fail "curl is required for runtime smoke checks"
  base_url=${SMOKE_BASE_URL:?Set SMOKE_BASE_URL to the public HTTPS origin}
  admin_url=${SMOKE_ADMIN_URL:?Set SMOKE_ADMIN_URL to the administrative HTTPS origin}

  expect_status 200 GET "$base_url/"
  expect_status 200 GET "$base_url/api/contacts?locale=ru&populate=*"
  expect_status 404 GET "$base_url/api/unknown"
  expect_status 400 GET "$base_url/api/projects?filters%5Bname%5D%5B%24eq%5D=secret"
  expect_status 400 GET "$base_url/api/projects?pagination%5BpageSize%5D=1"
  expect_status 400 GET "$base_url/api/projects?locale=ru&locale=en"
  expect_status 403 GET "$base_url/api/contacts" -H 'Origin: https://rejected.example'
  expect_status 404 GET "$base_url/admin"
  expect_status 404 GET "$base_url/upload"
  expect_status 400 GET "$base_url/api/projects/%2e%2e/admin"

  admin_status=$(status_for GET "$admin_url/admin")
  case "$admin_status" in
    401|403) ;;
    *) fail "unguarded admin request returned $admin_status, expected 401 or IP-denied 403" ;;
  esac

  if [ -n "${SMOKE_UPLOAD_PATH:-}" ]; then
    expect_status 200 GET "$base_url$SMOKE_UPLOAD_PATH"
  fi

  if [ -n "${SMOKE_EDGE_IP:-}" ]; then
    unknown_status=$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
      --resolve "unknown.example:443:$SMOKE_EDGE_IP" https://unknown.example/)
    [ "$unknown_status" = 000 ] || [ "$unknown_status" = 444 ] || \
      fail "unknown Host returned $unknown_status"
  fi

  echo "$mode deployment smoke passed"
}

case "$mode" in
  configuration) run_configuration ;;
  staging|production) run_runtime ;;
  *)
    echo "Usage: $0 [configuration|staging|production]" >&2
    exit 2
    ;;
esac
