# Build dependencies before admitting the immutable image to a runtime definition.
# Applications add their own startup, data services and synthetic fixtures.
FROM node:22-bookworm-slim
RUN mkdir -p /opt/browser && cd /opt/browser \
    && npm install --save-exact playwright@1.58.2 \
    && PLAYWRIGHT_BROWSERS_PATH=/opt/browsers npx playwright install --with-deps chromium \
    && chmod -R a+rX /opt/browsers \
    && rm -rf /var/lib/apt/lists/* /root/.npm
ENV NODE_PATH=/opt/browser/node_modules
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/browsers
ENV HOME=/scratch
ENV TMPDIR=/scratch
