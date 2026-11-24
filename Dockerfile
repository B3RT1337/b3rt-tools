FROM node:20-bookworm-slim

# ffmpeg: MP3 extraction + merging video/audio
# python3 + python-is-python3: yt-dlp needs Python, and yt-dlp-exec's
# install step looks for a binary named "python"
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 python-is-python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
