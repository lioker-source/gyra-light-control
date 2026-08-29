FROM node:22-alpine

WORKDIR /app

# Abhängigkeiten separat installieren, damit der Layer gecacht wird.
COPY package.json ./
RUN npm install --omit=dev

COPY . .

CMD ["node", "server.js"]
