FROM node:18-alpine3.15 as build

WORKDIR /build

COPY ["package.json", "package-lock.json", "./"]

RUN npm install

COPY . .

RUN npm run build

RUN ls -hal

FROM node:18-alpine3.15

ENV DB_HOST=localhost
ENV DB_PORT=5432
ENV DB_NAME=nostr-ts-relay
ENV DB_USER=nostr-ts-relay
ENV DB_PASSWORD=nostr-ts-relay

WORKDIR /app

COPY --from=build /build/dist .

RUN npm install --omit=dev

USER 1000:1000

CMD ["node", "src/index.js"]
