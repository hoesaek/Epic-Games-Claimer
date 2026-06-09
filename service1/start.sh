#!/bin/bash

# Configuration
export DISPLAY=:99
export RESOLUTION=1280x800x24

echo "🛠️ Démarrage de Xvfb..."
Xvfb $DISPLAY -screen 0 $RESOLUTION -ac +extension RANDR &
sleep 2

echo "🪟 Démarrage de Fluxbox..."
fluxbox &
sleep 1

echo "📡 Démarrage du serveur VNC (port 5900)..."
x11vnc -display $DISPLAY -nopw -forever -quiet -bg -xkb

echo "🌐 Démarrage de noVNC (port 6080)..."
websockify --web /usr/share/novnc/ 6080 localhost:5900 &
sleep 2

echo "======================================================="
echo "✅ Système visuel prêt !"
echo "👉 Ouvrez votre navigateur sur : http://[VOTRE_IP_SERVEUR]:6080/vnc.html"
echo "======================================================="

echo "🚀 Lancement du script de connexion..."
node index.js
