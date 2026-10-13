# Soul Society — KNIGHT + AEGIS production image.
# Works on linux/amd64 and linux/arm64 (e.g. Oracle Cloud Ampere). No secrets
# are baked in: configuration comes from environment variables at run time.
FROM node:22-bookworm-slim

# Fonts for welcome/rank cards (emoji + general fallback). Hieroglyph and math
# fonts used by stylised server names are bundled in assets/fonts.
RUN apt-get update \
 && apt-get install -y --no-install-recommends fonts-dejavu-core fonts-noto-color-emoji ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production \
    APP_ENV=production \
    SOUL_SOCIETY_NO_DOTENV=1 \
    DATA_DIR=/app/data \
    LOG_TO_FILE=false \
    npm_config_update_notifier=false

# Dependencies first for layer caching. ffmpeg-static downloads the ffmpeg
# binary for this platform during install (optional dependency).
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force \
 && node -e "const p=require('ffmpeg-static'); if(!p||!require('fs').existsSync(p)){console.error('ffmpeg-static missing');process.exit(1)} console.log('ffmpeg:',p)"

COPY . .
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node

# Persistent data: SQLite database, backups, uploaded welcome backgrounds.
VOLUME ["/app/data"]

HEALTHCHECK --interval=60s --timeout=10s --start-period=90s --retries=3 \
  CMD ["node", "--disable-warning=ExperimentalWarning", "scripts/healthcheck.js"]

# The launcher supervises both bots (restart with backoff) and shuts them
# down cleanly on SIGTERM. Run with an init process (compose: init: true).
CMD ["node", "--disable-warning=ExperimentalWarning", "apps/launcher.js"]
