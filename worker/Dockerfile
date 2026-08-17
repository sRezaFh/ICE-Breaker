FROM node:20-bookworm-slim

# xvfb: gives the container a real (virtual) X11 display, so nut-js's
# leftClick() dispatches a genuine OS-level input event instead of a
# CDP-simulated one - ICE's report-generation Submit rejects the latter
# even mid-session (see src/osClick.ts). libxtst6/libpng16-16/libx11-6 are
# nut-js's own runtime deps on Linux (its prebuilt native addon links
# against them); the rest are Chrome's standard headed-Linux dependencies.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb xauth x11-utils \
    ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcups2 \
    libdbus-1-3 libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 \
    libx11-6 libx11-xcb1 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
    libxtst6 libpng16-16 xdg-utils \
  && rm -rf /var/lib/apt/lists/*

# xvfb-run creates its X11 socket here - the xvfb package doesn't create this
# dir on its own in a minimal image with no init system, so without it
# xvfb-run hangs forever trying to acquire a display and never execs the app,
# which is why nothing (not even npm's own output) ever reached the logs
RUN mkdir -p /tmp/.X11-unix && chmod 1777 /tmp/.X11-unix

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

ENV HEADLESS=false
ENV PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

COPY . .
RUN npx puppeteer browsers install chrome && npm run build

# --auto-servernum picks a free display number - fixed :99 races a leftover
# lock file across restarts on the same instance
CMD ["xvfb-run", "--auto-servernum", "--server-args=-screen 0 1280x900x24", "npm", "run", "start:server"]
