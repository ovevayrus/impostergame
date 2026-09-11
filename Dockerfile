FROM node:24-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src
COPY --chown=node:node data ./data

RUN mkdir -p /app/.data && chown node:node /app/.data

USER node
ENV NODE_ENV=production
ENV DATA_FILE=/app/.data/state.json

VOLUME ["/app/.data"]
CMD ["node", "src/index.js"]
