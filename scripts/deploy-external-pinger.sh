#!/bin/env bash
set -euo pipefail

# deploy-external-pinger.sh
# Deploys an external pinger service to reliably trigger keeper workflows.
# This replaces the unreliable GitHub Actions native cron scheduler.

# Configuration
PINGER_URL="${PINGER_URL:-"https://your-pinger-service.example.com/ping"}"
KEEPER_REPO="${GITHUB_REPOSITORY:-"your-org/your-repo"}"
BRANCH="${GITHUB_REF_NAME:-main}"

# Function to deploy the pinger configuration
# In a real scenario, this would interact with a cloud provider (AWS, GPC, Azure)
# or a service like Cron-job.org, UptimeRobot, or a custom serverless function.

echo "Deploying external pinger for ${KEEPER_REPO}..."

# Example: Create a simple HTTP endpoint that triggers the GitHub API
# This script is a placeholder for the actual deployment logic.
# The actual pinger should hit the GitHub API to trigger the workflow.

# GitHub API endpoint to trigger a workflow run
WORKFLOW_TRIGGER_URL=""https://api.github.com/repos/${KEEPER_REPO/}/actions/workflows/keepers.yml/dispatches"

# Generate a unique run ID for the dispatch
REN_ID=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 8 | head -n 1)

# Create the payload
PAYLOAD=$(cat <<EOF
{
  "ref": "${BRANCH}",
  "inputs": {
    "run_id": "${RUN_ID}"
  }
}
EOF
)

# Note: In a real deployment, this script would be part of a CI/CD pipeline
# that sets up a cron job on an external server to execute a curl command 
# similar to the one below:
#
# curl -X POST \
#   -H "Accept: application/json" \
#   -H "Authorization: Bearer ${GITHUB_TOKEN}" \
#   -H" X-GitHub-Api-Version: 2022-11-28" \
#   -d "${PAYLOAD}" \
#   "${WORKFLOW_TRIGGER_URL}"

echo "External pinger deployment script prepared."
echo "Please ensure the following are configured:"
echo "1. A GITHUB_TOKEN with 'contents: write' and 'actions: write' permissions."
echo "2. An external server or service to run the cron job."
echo "3. The cron job should trigger the workflow dispatch at the desired intervals (e.g., every 5 minutes)."
