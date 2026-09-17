FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /opt/jevyr
RUN npm init -y && npm install --ignore-scripts --save-exact playwright@1.63.0 && npm cache clean --force
COPY browser-probe.mjs /opt/jevyr/browser-probe.mjs
COPY fonts.conf /opt/jevyr/fonts.conf
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV FONTCONFIG_FILE=/opt/jevyr/fonts.conf
RUN fc-cache --force
WORKDIR /jevyr-writable/work
