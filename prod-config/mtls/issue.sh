#!/bin/sh
set -eu

certificates_dir=/certificates
operator_name=${MTLS_OPERATOR_NAME:-operator}
ca_common_name=${MTLS_CA_COMMON_NAME:-Nonna-Admin-Client-CA}
ca_days=${MTLS_CA_DAYS:-3650}
client_days=${MTLS_CLIENT_DAYS:-365}

fail() {
  echo "mTLS certificate generation failed: $*" >&2
  exit 1
}

validate_name() {
  value=$1
  label=$2
  [ -n "$value" ] || fail "$label must not be empty"
  case "$value" in
    *[!A-Za-z0-9._-]*) fail "$label may contain only letters, digits, dot, underscore, and hyphen" ;;
  esac
}

validate_days() {
  value=$1
  label=$2
  case "$value" in
    ''|*[!0-9]*) fail "$label must be a positive integer" ;;
  esac
  [ "$value" -gt 0 ] || fail "$label must be a positive integer"
}

validate_name "$operator_name" MTLS_OPERATOR_NAME
validate_name "$ca_common_name" MTLS_CA_COMMON_NAME
validate_days "$ca_days" MTLS_CA_DAYS
validate_days "$client_days" MTLS_CLIENT_DAYS

mkdir -p "$certificates_dir"
umask 077

ca_key=$certificates_dir/admin-client-ca.key
ca_certificate=$certificates_dir/admin-client-ca.crt
ca_serial=$certificates_dir/admin-client-ca.srl
client_key=$certificates_dir/$operator_name.key
client_certificate=$certificates_dir/$operator_name.crt
work_dir=$(mktemp -d "$certificates_dir/.issue-work.XXXXXX")

cleanup() {
  rm -rf "$work_dir"
}
trap cleanup EXIT HUP INT TERM

if [ -e "$ca_key" ] && [ ! -s "$ca_certificate" ]; then
  fail "CA private key exists but CA certificate is missing or empty"
fi
if [ -e "$ca_certificate" ] && [ ! -s "$ca_key" ]; then
  fail "CA certificate exists but CA private key is missing or empty"
fi

if [ ! -e "$ca_key" ] && [ ! -e "$ca_certificate" ]; then
  ca_key_work=$work_dir/admin-client-ca.key
  ca_certificate_work=$work_dir/admin-client-ca.crt

  echo "Creating self-signed admin client CA"
  openssl req -x509 -newkey rsa:4096 -sha256 -noenc -batch -quiet \
    -days "$ca_days" \
    -subj "/CN=$ca_common_name" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" \
    -addext "subjectKeyIdentifier=hash" \
    -keyout "$ca_key_work" \
    -out "$ca_certificate_work"

  openssl verify -check_ss_sig \
    -CAfile "$ca_certificate_work" \
    "$ca_certificate_work"
  chmod 600 "$ca_key_work"
  chmod 644 "$ca_certificate_work"
  mv "$ca_key_work" "$ca_key"
  mv "$ca_certificate_work" "$ca_certificate"
fi

[ ! -e "$client_key" ] || fail "operator private key already exists: $client_key"
[ ! -e "$client_certificate" ] || fail "operator certificate already exists: $client_certificate"

client_request=$work_dir/client.csr
client_extensions=$work_dir/client.ext
client_key_work=$work_dir/$operator_name.key
client_certificate_work=$work_dir/$operator_name.crt
cat > "$client_extensions" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=clientAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
EOF

openssl req -new -newkey rsa:3072 -sha256 -noenc -batch -quiet \
  -subj "/CN=$operator_name" \
  -keyout "$client_key_work" \
  -out "$client_request"

openssl x509 -req -sha256 \
  -in "$client_request" \
  -CA "$ca_certificate" \
  -CAkey "$ca_key" \
  -CAserial "$ca_serial" \
  -CAcreateserial \
  -days "$client_days" \
  -extfile "$client_extensions" \
  -out "$client_certificate_work"

openssl verify -purpose sslclient -CAfile "$ca_certificate" "$client_certificate_work"
chmod 600 "$ca_key" "$ca_serial" "$client_key_work"
chmod 644 "$ca_certificate" "$client_certificate_work"
mv "$client_key_work" "$client_key"
mv "$client_certificate_work" "$client_certificate"

echo "Issued mTLS client certificate for $operator_name"
echo "CA certificate for the VPS: $ca_certificate"
echo "Operator certificate: $client_certificate"
echo "Operator private key: $client_key"
