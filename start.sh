#!/usr/bin/env bash
set -e

# Start FastAPI in background (internal)
uvicorn photo.validator_api:app --host 0.0.0.0 --port 8000 &

# Start Node in foreground (Render expects this one to stay running)
node server/index.js
