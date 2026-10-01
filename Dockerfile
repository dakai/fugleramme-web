FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./
COPY public ./public
ENV DATA_DIR=/data PORT=8090
VOLUME /data
EXPOSE 8090
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8090/ >/dev/null || exit 1
CMD ["node", "server.mjs"]
