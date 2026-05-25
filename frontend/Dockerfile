# ── Frontend Dockerfile — installs deps and pre-builds static assets ──
# Default CMD is dev server (for `docker-compose.yml`).
# Production compose (docker-compose.prod.yml) overrides with `npm run preview`,
# which serves the pre-built /dist directory.
FROM node:20-alpine
WORKDIR /app

# Install all deps (including devDependencies needed for build)
COPY package.json package-lock.json* ./
RUN npm install

# Copy source and pre-build for production preview mode
COPY . .


EXPOSE 5173
CMD ["npm", "run", "dev"]
