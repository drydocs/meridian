#!/usr/bin/env bash
set -euo pipefail

# deploy-external-pinger.sh
#
# Drives the Meridian keepers from an external cron/uptime service instead of
# relying on GitHub Actions' native cron (issue #796), whose scheduled triggers
# GitHub documents as delayable or droppable under load.
#
# The keeper endpoints already accept authenticated HTTP POSTs, so the external
# scheduler calls them directly; no GitHub token or workflow dispatch is
# involved. `.github/workflows/keepers.yml` stays in place as a backup driver
# until the external schedule is confirmed healthy in production.
#
# Required environment:
#   API_BASE_URL   Base URL of the deployed API (no trailing slash),
#                  e.g. https://meridian.example.com
#   CRON_SECRET    Bearer token the keeper endpoints authenticate against.
#
# Configure three jobs in the external scheduler, one per keeper, each set to
# retry on failure and alert on repeated failure (Cron-job.org and UptimeRobot
# both support this natively):
#
#   */5  * * * *   POST ${API_BASE_URL}/api/v1/keepers/alert
#   */15 * * * *   POST ${API_BASE_URL}/api/v1/keepers/accrue
#   0    * * * *   POST ${API_BASE_URL}/api/v1/keepers/rebalance
#
# Each request carries: Authorization: Bearer ${CRON_SECRET}
#
# Usage:
#   deploy-external-pinger.sh            Print the configuration to apply.
#   deploy-external-pinger.sh --verify   Additionally fire one authenticated
#                                        request per keeper to confirm the base
#                                        URL and token are correct before the
#                                        schedules are wired up.

API_BASE_URL="${API_BASE_URL:?API_BASE_URL must be set}"

print_config() {
  cat <<CONFIG
Configure these three jobs in your external scheduler:

  */5  * * * *   POST ${API_BASE_URL}/api/v1/keepers/alert
  */15 * * * *   POST ${API_BASE_URL}/api/v1/keepers/accrue
  0    * * * *   POST ${API_BASE_URL}/api/v1/keepers/rebalance

Every request must send the header:

  Authorization: Bearer \${CRON_SECRET}

Set each job to retry on failure and to alert on repeated failure. Leave
.github/workflows/keepers.yml enabled as a backup until these jobs have run
cleanly for at least 24 hours.
CONFIG
}

verify_endpoints() {
  local secret="${CRON_SECRET:?CRON_SECRET must be set for --verify}"
  local keeper
  for keeper in alert accrue rebalance; do
    echo "Pinging ${keeper} keeper..."
    curl -fsS -X POST "${API_BASE_URL}/api/v1/keepers/${keeper}" \
      -H "Authorization: Bearer ${secret}"
    echo "  ${keeper}: ok"
  done
  echo "Connectivity verified for all three keepers."
}

print_config

if [[ "${1:-}" == "--verify" ]]; then
  echo
  verify_endpoints
fi
