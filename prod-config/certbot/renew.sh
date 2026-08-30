#!/bin/sh
set -eu

interval=${CERTBOT_RENEW_INTERVAL:-43200}

while :; do
  certbot renew \
    --non-interactive \
    --webroot \
    --webroot-path /var/www/certbot \
    --config-dir /etc/letsencrypt \
    --work-dir /var/lib/letsencrypt \
    --logs-dir /var/log/letsencrypt
  sleep "$interval"
done
