# Utiliser Node.js LTS léger
FROM node:20-alpine

# Dossier de travail
WORKDIR /usr/src/app

# Copier package.json et installer les dépendances
COPY package*.json ./
RUN npm install --production

# Copier le reste du code
COPY . .

# Créer le dossier Uploads pour Multer
RUN mkdir -p /usr/src/app/Uploads

# Exposer le port backend
EXPOSE 5000

# Lancer le serveur
CMD ["node", "server.js"]
