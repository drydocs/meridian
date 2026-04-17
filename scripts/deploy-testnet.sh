#!/usr/bin/env bash
set -euo pipefail

# Deploy Meridian contracts to Stellar testnet
# Usage: bash scripts/deploy-testnet.sh

NETWORK="testnet"
RPC_URL="https://soroban-testnet.stellar.org"
PASSPHRASE="Test SDF Network ; September 2015"

echo "Building contracts..."
cd packages/contracts
stellar contract build

echo "Deploying to $NETWORK..."
# TODO(#issue-8): add contract deploy commands once contracts are written
echo "Deploy script placeholder — implement after contracts are authored"
