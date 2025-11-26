FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --only=production

# Copy application files
COPY . .

# Create directory for WhatsApp session
RUN mkdir -p .wwebjs_auth

# Expose port (optional, jika nanti ada web dashboard)
EXPOSE 3000

# Start bot
CMD ["node", "index.js"]
