# On utilise Alpine pour un Dockerfile ultra-léger (~150MB au lieu de 1GB+)
FROM node:20-alpine

# Installation de Chromium via les paquets Alpine natifs (très optimisé)
# On installe aussi xvfb au cas où on voudrait simuler un écran
RUN apk add --no-cache \
      chromium \
      nss \
      freetype \
      harfbuzz \
      ca-certificates \
      ttf-freefont

WORKDIR /app

# Variable d'environnement pour dire à Playwright d'utiliser le Chromium d'Alpine
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=true

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Lancement via un script shell pour setup Xvfb si besoin
CMD ["npm", "start"]
