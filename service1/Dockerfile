FROM node:20-bookworm-slim

# Empêcher les prompts interactifs pendant l'installation
ENV DEBIAN_FRONTEND=noninteractive

# Installation des dépendances graphiques (VNC + noVNC + Chromium)
RUN apt-get update && apt-get install -y \
    xvfb \
    x11vnc \
    fluxbox \
    novnc \
    websockify \
    chromium \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Installation des dépendances Node.js
COPY package.json ./
RUN npm install

# Copie du code source
COPY . .

# Variables d'environnement pour Playwright
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Script de démarrage
COPY start.sh /start.sh
RUN chmod +x /start.sh

# Port noVNC
EXPOSE 6080

CMD ["/start.sh"]
