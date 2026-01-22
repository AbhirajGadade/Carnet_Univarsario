#!/usr/bin/env bash
set -e

# start FastAPI internally
python -m uvicorn photo.validator_api:app --host 127.0.0.1 --port 8001 &

# start Node publicly (Koyeb checks this port)
node server/index.js
