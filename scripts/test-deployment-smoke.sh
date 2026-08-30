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

reject_pattern() {
  pattern=$1
  file=$2
  if grep -E "$pattern" "$file" >/dev/null; then
    fail "$file contains forbidden pattern: $pattern"
  fi
}

run_configuration() {
  command -v docker >/dev/null || fail "docker is required for Compose validation"
  command -v python3 >/dev/null || fail "python3 is required for resolved topology validation"

  test_root=$(mktemp -d "${TMPDIR:-/tmp}/nonna-deployment-smoke.XXXXXX")
  trap 'rm -rf "$test_root"' EXIT HUP INT TERM
  mkdir -p "$test_root/certbot/active" "$test_root/certbot-webroot"
  for secret in app-keys api-token-salt admin-jwt transfer-token jwt api-token; do
    printf 'configuration-test-%s\n' "$secret" > "$test_root/$secret"
  done
  printf 'configuration-test-admin-client-ca\n' > "$test_root/admin-client-ca.crt"

  env_file=$test_root/production.env
  {
    printf 'COMPOSE_PROJECT_NAME=nonna-configuration-test\n'
    printf 'DOMAIN=example.test\n'
    printf 'ADMIN_DOMAIN=admin.example.test\n'
    printf 'PUBLIC_BIND_ADDRESS=127.0.0.1\n'
    printf 'CERTBOT_STATE_DIR=%s/certbot\n' "$test_root"
    printf 'CERTBOT_WEBROOT_DIR=%s/certbot-webroot\n' "$test_root"
    printf 'ADMIN_CLIENT_CA_FILE=%s/admin-client-ca.crt\n' "$test_root"
    printf 'APP_KEYS_FILE=%s/app-keys\n' "$test_root"
    printf 'API_TOKEN_SALT_FILE=%s/api-token-salt\n' "$test_root"
    printf 'ADMIN_JWT_SECRET_FILE=%s/admin-jwt\n' "$test_root"
    printf 'TRANSFER_TOKEN_SALT_FILE=%s/transfer-token\n' "$test_root"
    printf 'JWT_SECRET_FILE=%s/jwt\n' "$test_root"
    printf 'API_BEARER_TOKEN_FILE=%s/api-token\n' "$test_root"
  } > "$env_file"

  resolved=$test_root/compose.json
  docker compose --env-file "$env_file" -f "$compose_file" config --format json > "$resolved"
  if ADMIN_CLIENT_CA_FILE= docker compose --env-file "$env_file" -f "$compose_file" \
    config >/dev/null 2>"$test_root/missing-admin-client-ca.err"; then
    fail "production Compose accepted an empty ADMIN_CLIENT_CA_FILE"
  fi
  require_pattern 'ADMIN_CLIENT_CA_FILE' "$test_root/missing-admin-client-ca.err"

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
nginx_command = " ".join(services["nginx"].get("command", []))
assert "/docker-entrypoint.sh nginx -t" in nginx_command, nginx_command
nginx_secrets = services["nginx"].get("secrets", [])
assert any(secret["source"] == "admin_client_ca" for secret in nginx_secrets), nginx_secrets
assert config["secrets"]["admin_client_ca"]["file"].endswith("/admin-client-ca.crt")
assert "admin_htpasswd" not in config.get("secrets", {})
nginx_volumes = services["nginx"].get("volumes", [])
assert not any("admin-allowlist" in volume.get("source", "") for volume in nginx_volumes)

for name in expected:
    assert services[name].get("read_only") is True, f"{name} rootfs is writable"
    assert "no-new-privileges:true" in services[name].get("security_opt", [])

frontend_environment = services["frontend"]["environment"]
cms_environment = services["cms"]["environment"]
assert "RECOVERY_GENERATION_ID" not in cms_environment
cms_volume_targets = {volume["target"] for volume in services["cms"].get("volumes", [])}
assert cms_volume_targets == {"/opt/app/.tmp", "/opt/app/public/uploads"}, cms_volume_targets
assert all(volume["type"] == "volume" for volume in services["cms"]["volumes"])
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
  require_pattern 'ssl_client_certificate /run/secrets/admin_client_ca' "$nginx_config"
  require_pattern 'ssl_verify_client on' "$nginx_config"
  require_pattern 'ssl_verify_depth 1' "$nginx_config"
  reject_pattern 'auth_basic|admin_htpasswd' "$nginx_config"
  reject_pattern 'admin-allowlist' "$nginx_config"
  reject_pattern 'ADMIN_ALLOWLIST|admin-allowlist' "$compose_file"
  reject_pattern 'ADMIN_ALLOWLIST|admin-allowlist' "$repo_root/.env.production.example"
  reject_pattern 'RECOVERY_GENERATION_ID|CMS_SEED_DATABASE|CMS_SEED_UPLOADS' "$compose_file"
  reject_pattern 'RECOVERY_GENERATION_ID|CMS_SEED_DATABASE|CMS_SEED_UPLOADS' "$repo_root/.env.production.example"
  require_pattern 'client_max_body_size 16m' "$nginx_config"
  require_pattern 'proxy_set_header Authorization \$http_authorization' "$nginx_config"
  require_pattern 'maxFileSize: 15 \* 1024 \* 1024' "$repo_root/cms/config/middlewares.js"
  require_pattern 'location \^~ /uploads/' "$nginx_config"
  require_pattern 'content-manager\|content-type-builder\|upload\|users-permissions' "$nginx_config"
  require_pattern 'return 308 https://\$host\$request_uri' "$nginx_config"
  require_pattern '^FROM alpine:3\.20$' "$repo_root/prod-config/mtls/Dockerfile"
  require_pattern '^\*\.key$' "$repo_root/prod-config/mtls/.dockerignore"

  node --test "$repo_root/nonna.ru/server/utils/api-contract.test.mjs"
  node --test "$repo_root/nonna.ru/utils/sanitize-cms-html.test.mjs"
  node --test \
    "$repo_root/cms/src/middlewares/validate-upload.test.js" \
    "$repo_root/cms/src/security/assert-public-role-empty.test.js"
  sh -n "$repo_root/prod-config/certbot/bootstrap.sh"
  sh -n "$repo_root/prod-config/certbot/renew.sh"
  sh -n "$repo_root/prod-config/mtls/generate.sh"
  sh -n "$repo_root/prod-config/mtls/issue.sh"
  sh -n "$repo_root/scripts/test-mtls-certificates.sh"

  echo "Production configuration smoke passed"
}

status_for() {
  method=$1
  url=$2
  shift 2
  curl --silent --show-error --output /dev/null --write-out '%{http_code}' \
    --connect-timeout "$smoke_connect_timeout" --max-time "$smoke_max_time" \
    --request "$method" "$@" "$url" || true
}

expect_status() {
  expected=$1
  method=$2
  url=$3
  shift 3
  actual=$(status_for "$method" "$url" "$@")
  [ "$actual" = "$expected" ] || fail "$method $url returned $actual, expected $expected"
}

expect_empty_collection() {
  url=$1
  body=$(curl --silent --show-error --fail \
    --connect-timeout "$smoke_connect_timeout" --max-time "$smoke_max_time" \
    "$url") || fail "GET $url did not return a successful response"
  printf '%s' "$body" | grep -Eq \
    '^[[:space:]]*\{[[:space:]]*"data"[[:space:]]*:[[:space:]]*\[[[:space:]]*\]' || \
    fail "GET $url returned a non-empty collection"
}

run_runtime() {
  command -v curl >/dev/null || fail "curl is required for runtime smoke checks"
  base_url=${SMOKE_BASE_URL:?Set SMOKE_BASE_URL to the public HTTPS origin}
  admin_url=${SMOKE_ADMIN_URL:?Set SMOKE_ADMIN_URL to the administrative HTTPS origin}
  admin_client_cert=${SMOKE_ADMIN_CLIENT_CERT:?Set SMOKE_ADMIN_CLIENT_CERT to the operator mTLS certificate}
  admin_client_key=${SMOKE_ADMIN_CLIENT_KEY:?Set SMOKE_ADMIN_CLIENT_KEY to the operator mTLS private key}
  [ -r "$admin_client_cert" ] || fail "SMOKE_ADMIN_CLIENT_CERT is not readable: $admin_client_cert"
  [ -r "$admin_client_key" ] || fail "SMOKE_ADMIN_CLIENT_KEY is not readable: $admin_client_key"
  smoke_connect_timeout=${SMOKE_CONNECT_TIMEOUT_SECONDS:-5}
  smoke_max_time=${SMOKE_MAX_TIME_SECONDS:-20}
  parquet_id=${SMOKE_PARQUET_ID:-1}
  project_id=${SMOKE_PROJECT_ID:-1}
  news_id=${SMOKE_SITE_NEWS_ID:-1}
  expect_empty_cms=${SMOKE_EXPECT_EMPTY_CMS:-false}
  case "$expect_empty_cms" in
    true) detail_status=404 ;;
    false) detail_status=200 ;;
    *) fail "SMOKE_EXPECT_EMPTY_CMS must be true or false" ;;
  esac

  expect_status 200 GET "$base_url/"
  for collection in contacts site-news-many parquets woods projects type-of-properties; do
    if [ "$expect_empty_cms" = true ]; then
      for locale in ru en; do
        expect_empty_collection "$base_url/api/$collection?locale=$locale&populate=*"
      done
    else
      expect_status 200 GET "$base_url/api/$collection?locale=ru&populate=*"
    fi
  done
  expect_status "$detail_status" GET "$base_url/api/parquets/$parquet_id?locale=ru&populate=*"
  expect_status "$detail_status" GET "$base_url/api/projects/$project_id?locale=ru&populate=*"
  expect_status "$detail_status" GET "$base_url/api/site-news-many/$news_id?locale=ru&populate=*"
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
    000|400) ;;
    *) fail "admin request without a client certificate returned $admin_status, expected mTLS denial" ;;
  esac

  expect_status 200 GET "$admin_url/admin" \
    --cert "$admin_client_cert" \
    --key "$admin_client_key"

  if [ -n "${SMOKE_UPLOAD_PATH:-}" ]; then
    expect_status 200 GET "$base_url$SMOKE_UPLOAD_PATH"
  fi

  if [ -n "${SMOKE_EDGE_IP:-}" ]; then
    unknown_status=$(curl --insecure --silent --output /dev/null --write-out '%{http_code}' \
      --connect-timeout "$smoke_connect_timeout" --max-time "$smoke_max_time" \
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
