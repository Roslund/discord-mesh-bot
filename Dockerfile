FROM node:23-alpine

# Create app directory
WORKDIR /usr/src/app

# Copy package files and install deps
COPY package*.json ./
RUN npm install

# Copy bot code
COPY . .

# Expose nothing, since it's a bot
CMD [ "node", "index.js" ]
