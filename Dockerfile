
# Headless Chrome + Playwright
FROM apify/actor-node-playwright-chrome:latest

WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . ./

CMD ["node", "main.js"]
