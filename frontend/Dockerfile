# ==============================================================================
# PackingProof Web — Frontend Static App Shell + Caddy Reverse Proxy Dockerfile
# Build context: ./frontend
# ==============================================================================
FROM node:24-alpine AS build
WORKDIR /build

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build

# ==============================================================================
# Runtime Stage — Caddy 2 serving SPA & Same-Origin HTTPS Reverse Proxy
# ==============================================================================
FROM caddy:2-alpine AS runtime
COPY --from=build /build/dist /srv/www

EXPOSE 80 443
