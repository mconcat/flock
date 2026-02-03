#!/bin/bash
# Flock Live CLI — Talk to agents
#
# Usage:
#   ./live/cli.sh <agent> <message>
#   ./live/cli.sh atlas "Summarize the A2A protocol"
#   ./live/cli.sh forge "Write a fibonacci function in TypeScript"
#   ./live/cli.sh sentinel "Install curl in the workspace"
#
# Commands:
#   ./live/cli.sh --agents         List all agents
#   ./live/cli.sh --a2a <agent> <message>  Send raw A2A message
#   ./live/cli.sh --tasks <agent>  Check agent's tasks
#   ./live/cli.sh --health         Check gateway health

set -e

PORT="${FLOCK_PORT:-4000}"
TOKEN="${FLOCK_GATEWAY_TOKEN:?Set FLOCK_GATEWAY_TOKEN environment variable}"
BASE="http://localhost:${PORT}"

# Colors
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
NC='\033[0m'

case "${1}" in
  --health)
    echo -e "${CYAN}Checking gateway health...${NC}"
    curl -s "${BASE}/health" \
      -H "Authorization: Bearer ${TOKEN}" | jq .
    ;;

  --agents)
    echo -e "${CYAN}Discovering agents...${NC}"
    curl -s "${BASE}/flock/.well-known/agent-card.json" \
      -H "Authorization: Bearer ${TOKEN}" | jq '.agents[] | {id, name, description}'
    ;;

  --a2a)
    AGENT="${2:?Usage: cli.sh --a2a <agent> <message>}"
    MESSAGE="${3:?Usage: cli.sh --a2a <agent> <message>}"
    echo -e "${CYAN}Sending A2A message to ${AGENT}...${NC}"
    curl -s -X POST "${BASE}/flock/a2a/${AGENT}" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -d "{
        \"jsonrpc\": \"2.0\",
        \"method\": \"message/send\",
        \"params\": {
          \"message\": {
            \"kind\": \"message\",
            \"messageId\": \"cli-$(date +%s)-${RANDOM}\",
            \"role\": \"user\",
            \"parts\": [{\"kind\": \"text\", \"text\": \"${MESSAGE}\"}]
          }
        },
        \"id\": \"cli-$(date +%s)\"
      }" | jq .
    ;;

  --tasks)
    AGENT="${2:?Usage: cli.sh --tasks <agent>}"
    echo -e "${CYAN}Checking tasks for ${AGENT}...${NC}"
    # This goes through the gateway chat completions to invoke flock_tasks
    curl -s -X POST "${BASE}/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "X-Clawdbot-Agent-Id: ${AGENT}" \
      -d "{
        \"model\": \"clawdbot/${AGENT}\",
        \"messages\": [{\"role\": \"user\", \"content\": \"Use flock_tasks to list all your current tasks and report the results.\"}],
        \"stream\": false
      }" | jq -r '.choices[0].message.content // "No response"'
    ;;

  -h|--help|"")
    echo "Flock Live CLI"
    echo ""
    echo "Usage:"
    echo "  ./live/cli.sh <agent> <message>     Talk to an agent via gateway"
    echo "  ./live/cli.sh --agents              List all registered agents"
    echo "  ./live/cli.sh --a2a <agent> <msg>   Send raw A2A message"
    echo "  ./live/cli.sh --tasks <agent>       Check agent's task list"
    echo "  ./live/cli.sh --health              Check gateway health"
    echo ""
    echo "Agents: atlas (research), forge (coder), sentinel (sysadmin)"
    echo ""
    echo "Examples:"
    echo "  ./live/cli.sh atlas \"What is the A2A protocol?\""
    echo "  ./live/cli.sh forge \"Write hello world in TypeScript\""
    echo "  ./live/cli.sh --a2a atlas \"Discover other agents and introduce yourself\""
    ;;

  *)
    AGENT="${1}"
    shift
    MESSAGE="$*"
    if [ -z "${MESSAGE}" ]; then
      echo "Usage: ./live/cli.sh <agent> <message>"
      exit 1
    fi
    echo -e "${GREEN}→ ${AGENT}:${NC} ${MESSAGE}"
    echo ""
    RESPONSE=$(curl -s -X POST "${BASE}/v1/chat/completions" \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "X-Clawdbot-Agent-Id: ${AGENT}" \
      -d "{
        \"model\": \"clawdbot/${AGENT}\",
        \"messages\": [{\"role\": \"user\", \"content\": $(echo "${MESSAGE}" | jq -Rs .)}],
        \"stream\": false
      }")

    # Extract and display the response
    CONTENT=$(echo "${RESPONSE}" | jq -r '.choices[0].message.content // empty')
    if [ -n "${CONTENT}" ]; then
      echo -e "${YELLOW}← ${AGENT}:${NC}"
      echo "${CONTENT}"
    else
      echo "Error or empty response:"
      echo "${RESPONSE}" | jq .
    fi
    ;;
esac
