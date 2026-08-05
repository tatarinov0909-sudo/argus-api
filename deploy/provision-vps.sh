#!/usr/bin/env bash
# Run once on a fresh Ubuntu 22.04/24.04 VPS, as root, to set up
# everything argus-api needs: Node.js, PostgreSQL, nginx, certbot, pm2.
# This is a checklist turned into a script, not a black box — read it
# before running it.
set -euo pipefail

DOMAIN="api.argus-ai.online"
APP_DIR="/opt/argus-api"
DB_NAME="argus"
DB_APP_USER="argus_app"

echo "==> System update"
apt-get update -y && apt-get upgrade -y

echo "==> Node.js LTS via NodeSource"
curl -fsSL https://deb.nodesource.com/setup_lts.x | bash -
apt-get install -y nodejs

echo "==> PostgreSQL"
apt-get install -y postgresql postgresql-contrib
systemctl enable postgresql --now

echo "==> nginx + certbot"
apt-get install -y nginx certbot python3-certbot-nginx

echo "==> pm2 (process manager for the Node app)"
npm install -g pm2

echo "==> Creating database ${DB_NAME}"
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};" || true

echo "==> App directory"
mkdir -p "${APP_DIR}"
echo "Now: rsync/scp the argus-api project into ${APP_DIR}, then continue with:"
echo "  cd ${APP_DIR} && npm install --production"
echo "  npm run migrate:up   (using an admin DATABASE_URL, e.g. postgres://postgres@localhost/${DB_NAME})"
echo "  psql -U postgres -d ${DB_NAME} -f src/db/setup-app-role.sql   (edit the password in that file first!)"
echo "  cp .env.example .env && edit .env: DATABASE_URL uses ${DB_APP_USER}, set a real JWT_SECRET"
echo "  pm2 start src/server.js --name argus-api"
echo "  pm2 save && pm2 startup"
echo ""
echo "==> nginx reverse proxy for ${DOMAIN}"
cat > /etc/nginx/sites-available/argus-api <<NGINX
server {
    listen 80;
    server_name ${DOMAIN};

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
NGINX
ln -sf /etc/nginx/sites-available/argus-api /etc/nginx/sites-enabled/argus-api
nginx -t && systemctl reload nginx

echo ""
echo "==> Before running certbot: make sure the DNS A record for ${DOMAIN}"
echo "    points at this server's IP (reg.ru -> Управление DNS)."
echo "    Then run: certbot --nginx -d ${DOMAIN}"
