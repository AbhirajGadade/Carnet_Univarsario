FROM python:3.11-slim

# Install node
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
  && apt-get update && apt-get install -y nodejs && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy files
COPY . .

# Install node deps
RUN npm ci --omit=dev || npm install

# Install python deps (choose one)
# If you have requirements.txt:
RUN pip install --no-cache-dir -r requirements.txt

# Expose Render port
ENV PORT=5000

# Start both: python on 8000 (internal), node on $PORT (public)
CMD bash -lc "uvicorn photo.validator_api:app --host 127.0.0.1 --port 8000 & node server/index.js"
