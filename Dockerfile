# GmailFlow geliştirme ortamı (yalnızca geliştirme içindir; son kullanıcı paketine dahil edilmez).
# Fastify API (3000) + Vite (5173) canlı yeniden yükleme ile çalışır. SQLite, Node'un yerleşik
# node:sqlite modülüyle kullanıldığı için yerel derleme veya ek kurulum gerekmez.
FROM node:24-bookworm-slim

ENV NODE_ENV=development \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    HOST=0.0.0.0 \
    PORT=3000 \
    GMAILFLOW_DATA_DIR=/data \
    CHOKIDAR_USEPOLLING=1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .

EXPOSE 3000 5173
CMD ["npm", "run", "dev:web"]
