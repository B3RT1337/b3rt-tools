FROM node:20-bookworm-slim

# ffmpeg: MP3 extraction + merging video/audio. python3: runs the yt-dlp script.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg python3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
# yt-dlp-exec downloads the yt-dlp binary at install time.
# Rebuild/redeploy now and then (clear build cache) to pick up yt-dlp fixes.
RUN npm install --omit=dev

COPY . .
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
