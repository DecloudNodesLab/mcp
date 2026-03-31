FROM node:22-bookworm-slim

ENV NODE_ENV=production

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

EXPOSE 3000

CMD ["node", "server.mjs"]
