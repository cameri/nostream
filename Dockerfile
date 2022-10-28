FROM node:18-alpine3.16 as build

WORKDIR /build

COPY ["package.json", "package-lock.json", "./"]

RUN npm install --quiet

COPY . .

RUN npm run build

FROM node:18-alpine3.16

LABEL org.opencontainers.image.title="Nostr Typescript Relay"
LABEL org.opencontainers.image.source=https://github.com/Cameri/nostr-ts-relay
LABEL org.opencontainers.image.description="nostr-ts-relay"
LABEL org.opencontainers.image.authors="Ricardo Arturo Cabral Mejía"
LABEL org.opencontainers.image.licenses=MIT


ENV DB_HOST=localhost
ENV DB_PORT=5432
ENV DB_NAME=nostr-ts-relay
ENV DB_USER=nostr-ts-relay
ENV DB_PASSWORD=nostr-ts-relay

WORKDIR /app

COPY --from=build /build/dist .

RUN npm install --omit=dev --quiet

USER 1000:1000

CMD ["node", "src/index.js"]
