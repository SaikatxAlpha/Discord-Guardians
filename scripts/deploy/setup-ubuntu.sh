#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu 22.04/24.04 VM (x86_64 or ARM, e.g. Oracle
# Cloud Always Free) to run Soul Society with Docker. Contains NO secrets.
# Usage on the VM:
#   git clone https://github.com/SaikatxAlpha/Discord-Guardians.git soul-society
#   cd soul-society && bash scripts/deploy/setup-ubuntu.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

if ! command -v docker >/dev/null 2>&1; then
  echo "Installing Docker from Ubuntu's repositories..."
  sudo apt-get update
  sudo apt-get install -y docker.io docker-compose-v2 || sudo apt-get install -y docker.io docker-compose-plugin
  sudo systemctl enable --now docker
  sudo usermod -aG docker "$USER"
  echo "Docker installed. Log out and back in (or run 'newgrp docker'), then re-run this script."
  exit 0
fi

if [ ! -f .env.production ]; then
  cp .env.production.example .env.production
  chmod 600 .env.production
  echo "Created .env.production — fill in KNIGHT_TOKEN, AEGIS_TOKEN (and optional keys):"
  echo "  nano .env.production"
  echo "Then re-run: bash scripts/deploy/setup-ubuntu.sh"
  exit 0
fi
chmod 600 .env.production

docker compose build
docker compose run --rm guardians node --disable-warning=ExperimentalWarning scripts/check-production.js --live
docker compose run --rm guardians node --disable-warning=ExperimentalWarning apps/register-commands.js
docker compose up -d
echo "Waiting for the health check (up to 3 minutes)..."
for i in $(seq 1 18); do
  sleep 10
  status=$(docker inspect --format '{{.State.Health.Status}}' soul-society 2>/dev/null || echo unknown)
  echo "  health: $status"
  [ "$status" = "healthy" ] && { echo "Both guardians are online."; exit 0; }
done
echo "Not healthy yet. Inspect with: docker compose logs --tail=100 guardians"
exit 1
