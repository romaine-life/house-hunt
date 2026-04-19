FROM node:20-alpine

WORKDIR /app

COPY backend/package*.json backend/
ARG NPM_TOKEN
RUN cd backend && \
    echo "//npm.pkg.github.com/:_authToken=${NPM_TOKEN}" > .npmrc && \
    echo "@nelsong6:registry=https://npm.pkg.github.com" >> .npmrc && \
    npm install --omit=dev && \
    rm -f .npmrc

COPY frontend/ frontend/
COPY backend/ backend/

RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app
USER nodejs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

CMD ["node", "backend/server.js"]
