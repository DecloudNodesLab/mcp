FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3000 \
    WORKSPACE_ROOT=/workspace \
    MAX_READ_BYTES=200000 \
    MAX_LIST_ENTRIES=200 \
    ALLOWED_PROGRAMS="pwd,ls,cat,grep,find,sed,head,tail,wc,git,node,npm,npx,python3,pytest,go,make"

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY server.mjs ./

RUN mkdir -p /workspace

EXPOSE 3000

CMD ["node", "server.mjs"]
