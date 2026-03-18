FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --production

COPY tsconfig.json ./
COPY src/ ./src/

# Build TypeScript
RUN npx tsc

# Railway cron runs this command
CMD ["node", "dist/index.js"]
