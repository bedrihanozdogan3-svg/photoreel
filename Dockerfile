FROM node:20-slim

WORKDIR /app

# Package files
COPY package*.json ./
RUN npm ci --only=production

# App files
COPY . .

# Cloud Run port
ENV PORT=8080
ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "server.js"]
