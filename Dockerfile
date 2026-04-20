FROM node:24-alpine AS build

WORKDIR /build

COPY ["package.json", "pnpm-lock.yaml", "./"]

RUN corepack enable && pnpm install --frozen-lockfile --silent

COPY . .

RUN pnpm run build

FROM node:24-alpine

LABEL org.opencontainers.image.title="Nostream"
LABEL org.opencontainers.image.source=https://github.com/cameri/nostream
LABEL org.opencontainers.image.description="nostream"
LABEL org.opencontainers.image.authors="Ricardo Arturo Cabral Mejía"
LABEL org.opencontainers.image.licenses=MIT

WORKDIR /app
RUN apk add --no-cache --update git

ADD resources /app/resources

COPY --from=build /build/dist .
COPY --from=build /build/package.json /build/pnpm-lock.yaml ./

RUN corepack enable && pnpm install --prod --frozen-lockfile --silent

USER node:node

CMD ["node", "src/index.js"]
