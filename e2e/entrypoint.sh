#!/bin/sh
# Flock E2E entrypoint — copies auth credentials if mounted
if [ -f /tmp/host-auth-profiles.json ]; then
  cp /tmp/host-auth-profiles.json /root/.openclaw/agents/main/agent/auth-profiles.json
fi
exec "$@"
