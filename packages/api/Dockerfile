# Conduit settlement API. Builds cmd/api (the production entrypoint that
# takes DATABASE_URL) — NOT cmd/devserver, which embeds its own Postgres and
# is strictly a local-development convenience.
FROM golang:1.26-alpine AS build

WORKDIR /src

# Dependencies first so a code-only change doesn't re-download the module
# graph on every build.
COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/conduit-api ./cmd/api

FROM alpine:3.20

# TLS roots: the API calls Circle (StableFX, Gateway) and Arc over HTTPS and
# would fail certificate verification without them on a scratch/alpine base.
RUN apk add --no-cache ca-certificates && adduser -D -u 10001 conduit

COPY --from=build /out/conduit-api /usr/local/bin/conduit-api
# Migrations are read at startup by golang-migrate, so they must ship in the
# image alongside the binary.
COPY --from=build /src/migrations /migrations

USER conduit
EXPOSE 8080

# Required at runtime: DATABASE_URL, STABLEFX_API_KEY.
# Optional: PRIVY_APP_ID + PRIVY_VERIFICATION_KEY (merchant login),
#           ARC_RELAYER_KEY (cross-chain funding — signs only, holds no gas),
#           CONDUIT_ALLOWED_ORIGINS (CORS allowlist; wildcard if unset).
ENV CONDUIT_MIGRATIONS_DIR=/migrations

ENTRYPOINT ["/usr/local/bin/conduit-api"]
