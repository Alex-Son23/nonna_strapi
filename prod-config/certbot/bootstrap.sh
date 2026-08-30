#!/bin/sh
set -eu

compose_file=${COMPOSE_FILE:-prod-config/docker-compose.yml}
env_file=${PRODUCTION_ENV_FILE:-.env.production}

: "${DOMAIN:?Export DOMAIN before running this script}"
: "${ADMIN_DOMAIN:?Export ADMIN_DOMAIN before running this script}"
: "${CERTBOT_EMAIL:?Export CERTBOT_EMAIL before running this script}"
: "${CERTBOT_STATE_DIR:?Export CERTBOT_STATE_DIR before running this script}"

case ${1:-bootstrap} in
  bootstrap)
    active_dir=$CERTBOT_STATE_DIR/active
    mkdir -p "$active_dir"

    if [ ! -s "$active_dir/fullchain.pem" ] || [ ! -s "$active_dir/privkey.pem" ]; then
      openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
        -subj "/CN=$DOMAIN" \
        -addext "subjectAltName=DNS:$DOMAIN,DNS:www.$DOMAIN,DNS:$ADMIN_DOMAIN" \
        -keyout "$active_dir/privkey.pem" \
        -out "$active_dir/fullchain.pem"
      chmod 600 "$active_dir/privkey.pem"
    fi

    docker compose --env-file "$env_file" -f "$compose_file" up -d cms frontend nginx
    docker compose --env-file "$env_file" -f "$compose_file" run --rm \
      --entrypoint certbot certbot certonly \
      --non-interactive --agree-tos --no-eff-email \
      --email "$CERTBOT_EMAIL" \
      --webroot --webroot-path /var/www/certbot \
      --config-dir /etc/letsencrypt \
      --work-dir /var/lib/letsencrypt \
      --logs-dir /var/log/letsencrypt \
      --cert-name "$DOMAIN" \
      -d "$DOMAIN" -d "www.$DOMAIN" -d "$ADMIN_DOMAIN"

    rm -f "$active_dir/fullchain.pem" "$active_dir/privkey.pem"
    ln -s "../live/$DOMAIN/fullchain.pem" "$active_dir/fullchain.pem"
    ln -s "../live/$DOMAIN/privkey.pem" "$active_dir/privkey.pem"
    docker compose --env-file "$env_file" -f "$compose_file" exec nginx nginx -s reload
    docker compose --env-file "$env_file" -f "$compose_file" up -d certbot
    ;;
  renewal-test)
    docker compose --env-file "$env_file" -f "$compose_file" run --rm \
      --entrypoint certbot certbot renew --dry-run \
      --non-interactive \
      --webroot --webroot-path /var/www/certbot \
      --config-dir /etc/letsencrypt \
      --work-dir /var/lib/letsencrypt \
      --logs-dir /var/log/letsencrypt
    docker compose --env-file "$env_file" -f "$compose_file" exec nginx nginx -s reload
    ;;
  *)
    echo "Usage: $0 [bootstrap|renewal-test]" >&2
    exit 2
    ;;
esac
