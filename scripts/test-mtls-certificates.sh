#!/bin/sh
set -eu

repo_root=$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)
generator=$repo_root/prod-config/mtls/generate.sh
test_root=$(mktemp -d "${TMPDIR:-/tmp}/nonna-mtls-test.XXXXXX")
test_image=${MTLS_TOOLS_IMAGE:-nonna-mtls-tools:test}

cleanup() {
  chmod -R u+rwX "$test_root" 2>/dev/null || true
  rm -rf "$test_root"
}
trap cleanup EXIT HUP INT TERM

run_issuer() {
  operator_name=$1
  docker run --rm \
    --user "$(id -u):$(id -g)" \
    --env "MTLS_OPERATOR_NAME=$operator_name" \
    --mount "type=bind,source=$test_root,target=/certificates" \
    "$test_image"
}

MTLS_OUTPUT_DIR=$test_root MTLS_OPERATOR_NAME=alice MTLS_TOOLS_IMAGE=$test_image "$generator"
test -s "$test_root/admin-client-ca.crt"
test -s "$test_root/admin-client-ca.key"
test -s "$test_root/admin-client-ca.srl"
test -s "$test_root/alice.crt"
test -s "$test_root/alice.key"

docker run --rm \
  --entrypoint openssl \
  --mount "type=bind,source=$test_root,target=/certificates,readonly" \
  "$test_image" \
  x509 -checkend 31449600 -noout \
  -in /certificates/alice.crt

if docker run --rm \
  --entrypoint openssl \
  --mount "type=bind,source=$test_root,target=/certificates,readonly" \
  "$test_image" \
  x509 -checkend 31622400 -noout \
  -in /certificates/alice.crt; then
  echo "mTLS client certificate unexpectedly remains valid after 366 days" >&2
  exit 1
fi

ca_checksum=$(cksum "$test_root/admin-client-ca.crt")
run_issuer bob
test "$ca_checksum" = "$(cksum "$test_root/admin-client-ca.crt")"
test -s "$test_root/bob.crt"
test -s "$test_root/bob.key"

if run_issuer alice >/dev/null 2>&1; then
  echo "mTLS generator unexpectedly overwrote an existing operator certificate" >&2
  exit 1
fi

if run_issuer 'invalid/name' >/dev/null 2>&1; then
  echo "mTLS generator unexpectedly accepted an unsafe operator name" >&2
  exit 1
fi

mv "$test_root/admin-client-ca.key" "$test_root/admin-client-ca.key.valid"
printf '%s\n' 'not a private key' > "$test_root/admin-client-ca.key"
if run_issuer carol >/dev/null 2>&1; then
  echo "mTLS generator unexpectedly issued a certificate with an invalid CA key" >&2
  exit 1
fi
test ! -e "$test_root/carol.crt"
test ! -e "$test_root/carol.key"
mv "$test_root/admin-client-ca.key" "$test_root/admin-client-ca.key.invalid"
mv "$test_root/admin-client-ca.key.valid" "$test_root/admin-client-ca.key"
run_issuer carol
test -s "$test_root/carol.crt"
test -s "$test_root/carol.key"

docker run --rm \
  --entrypoint openssl \
  --mount "type=bind,source=$test_root,target=/certificates,readonly" \
  "$test_image" \
  verify -check_ss_sig \
  -CAfile /certificates/admin-client-ca.crt \
  /certificates/admin-client-ca.crt

docker run --rm \
  --entrypoint openssl \
  --mount "type=bind,source=$test_root,target=/certificates,readonly" \
  "$test_image" \
  verify -purpose sslclient \
  -CAfile /certificates/admin-client-ca.crt \
  /certificates/alice.crt /certificates/bob.crt /certificates/carol.crt

echo "Self-issued mTLS certificate test passed"
