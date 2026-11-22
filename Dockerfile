# 问津 Wenjin —— 零依赖 Node.js 服务
FROM node:22-alpine

WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    DATA_DIR=/app/data

COPY server.js websearch.js mailcap.js db.example.json ./
COPY public ./public

RUN mkdir -p /app/data && chown -R node:node /app
USER node

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/config" >/dev/null || exit 1

CMD ["node", "server.js"]
