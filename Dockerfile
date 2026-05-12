FROM node:24-bookworm

WORKDIR /app

COPY package*.json ./
RUN npm ci
RUN npx playwright install --with-deps chromium

COPY . .
RUN npm run build

ENV NODE_ENV=production
ENV PORT=8080

CMD ["node", "dist/src/cli.js", "api"]
