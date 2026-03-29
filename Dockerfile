FROM node:20-slim

WORKDIR /app

# FFmpeg — video kesme + ses ayırma için
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

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
