#!/bin/bash
cd "$(dirname "$0")"
echo "Pomodoro Dashboard → http://localhost:8787"
open "http://localhost:8787"
bun server.js
