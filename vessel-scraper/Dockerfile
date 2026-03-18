FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* .npmrc ./

# Install all dependencies (need typescript for build)
RUN npm install --legacy-peer-deps

# Copy source
COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Prune dev dependencies
RUN npm prune --production 2>/dev/null || true

# Railway cron runs this command
CMD ["node", "dist/index.js"]
