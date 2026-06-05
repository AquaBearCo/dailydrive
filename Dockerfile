FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; else npm install --omit=dev; fi

COPY . .
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production \
    CONFIG_DIR=/config \
    SCHEDULE=04:00,16:00 \
    RUN_ON_START=false \
    SPOTIFY_SETUP_BIND_HOST=0.0.0.0

VOLUME ["/config"]
EXPOSE 8888

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["scheduler"]
