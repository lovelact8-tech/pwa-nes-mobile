FROM node:22-alpine

WORKDIR /app
COPY relay-server/package.json relay-server/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY relay-server/server.mjs relay-server/cloud-store.mjs ./relay-server/
USER node
ENV HOST=0.0.0.0 PORT=8787 CLOUD_DATA_DIR=/data
EXPOSE 8787
VOLUME ["/data"]
CMD ["node", "relay-server/server.mjs"]
