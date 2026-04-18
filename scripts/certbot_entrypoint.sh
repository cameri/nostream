#!/bin/sh
set -e

DOMAIN="${RELAY_DOMAIN:?RELAY_DOMAIN required}"
EMAIL="${CERTBOT_EMAIL:?CERTBOT_EMAIL required}"

# Remove dummy self-signed cert if certbot hasn't created a real lineage yet
if [ ! -f "/etc/letsencrypt/renewal/${DOMAIN}.conf" ]; then
  rm -rf "/etc/letsencrypt/live/${DOMAIN}"
fi

# Obtain certificate
certbot certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "${EMAIL}" \
  --agree-tos \
  --no-eff-email \
  --keep-until-expiring \
  -n \
  -d "${DOMAIN}" \
  --deploy-hook 'touch /etc/letsencrypt/reload-nginx'

# Renew loop
trap exit TERM
while :; do
  certbot renew --quiet \
    --deploy-hook 'touch /etc/letsencrypt/reload-nginx'
  sleep 12h & wait $!
done
