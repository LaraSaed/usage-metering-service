# Image for the metering service.
# Build step: compile TypeScript to dist/. Run step: start the compiled server.
FROM node:22-alpine

WORKDIR /app

# Install packages first, so Docker can reuse this layer when only code changes.
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

EXPOSE 3000
CMD ["node", "dist/server.js"]