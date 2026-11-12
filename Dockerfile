# Playwright's image ships Chromium and its system libraries, so the browser-based checks work out of the box.
FROM mcr.microsoft.com/playwright:v1.65.0-noble
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
RUN npm run build:brands
USER pwuser
EXPOSE 3000
ENV HOST=0.0.0.0 PORT=3000
CMD ["npx", "tsx", "src/node.ts"]
