#!/usr/bin/env bash
set -euo pipefail

# Deploy a fresh BlendAdapter and point an already-live coordinator vault at
# it via set_adapter. Use this to push new adapter code (e.g. accrue(),
# get_pool(), get_protocol()) to a live vault without redeploying the vault
# itself, since adapter contracts have no in-place upgrade path (no
# update_current_contract_wasm function) — the only way to update an
# adapter's code is to deploy a new contract and swap the vault onto it.
#
# IMPORTANT: set_adapter does not move any funds out of the old adapter,
# and it does not reset the vault's adapter-share accounting (ADPT_SH):
# the contract rejects it with AdapterSwapUnsafe unless both TOTAL_SH and
# ADPT_SH are already zero, and leaves ADPT_SH untouched so a stranded
# position at the old adapter stays visible. If the vault has real
# depositors, use migrate_adapter instead of set_adapter for the final step
# this script prints, it moves the vault's entire position to the new
# adapter atomically, with a slippage-bounded value check, and does not
# require every depositor to withdraw first. set_adapter remains correct
# only for a vault with no depositors yet (e.g. right after a fresh deploy,
# before any real funds are at risk).
#
# Usage: VAULT_ID=<live vault> DEPLOYER=<key> [NETWORK=testnet|mainnet] bash scripts/redeploy-blend-adapter.sh

NETWORK="${NETWORK:-testnet}"
if [ "$NETWORK" != "testnet" ] && [ "$NETWORK" != "mainnet" ]; then
  echo "ERROR: NETWORK must be 'testnet' or 'mainnet' (got '$NETWORK')." >&2
  exit 1
fi

# DEPLOYER pays deployment transaction fees. It does not need to be the vault's
# admin to deploy the new adapter, but it DOES need to be the vault's admin to
# run the set_adapter/migrate_adapter command this script prints at the end.
: "${DEPLOYER:?DEPLOYER env var required (Stellar secret key)}"

# VAULT_ID is required, with no default. The vault address is a constructor
# argument now, so it is written into the adapter by the deploying transaction
# and cannot be changed afterwards. A stale default here would permanently bind
# a fresh adapter to the wrong vault, with a redeploy as the only way out.
: "${VAULT_ID:?VAULT_ID env var required (the live vault this adapter serves)}"

if [ "$NETWORK" = "mainnet" ]; then
  # Values from packages/shared/src/constants.ts (CONTRACT_ADDRESSES.mainnet)
  BLEND_POOL_ID="${BLEND_POOL_ID:-CAJJZSGMMM3PD7N33TAPHGBUGTB43OC73HVIK2L2G6BNGGGYOSSYBXBD}"
  USDC_ID="${USDC_ID:-CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75}"
else
  # Values from packages/shared/src/constants.ts (CONTRACT_ADDRESSES.testnet)
  BLEND_POOL_ID="${BLEND_POOL_ID:-CCEBVDYM32YNYCVNRXQKDFFPISJJCV557CDZEIRBEE4NCV4KHPQ44HGF}"
  USDC_ID="${USDC_ID:-CAQCFVLOBK5GIULPNZRGATJJMIZL5BSP7X5YJVMGCPTUEPFM4AVSRCJU}"
fi

if [ "$NETWORK" = "mainnet" ]; then
  echo "About to build and deploy a new Blend adapter to MAINNET with:"
  echo "  VAULT_ID:      $VAULT_ID"
  echo "  BLEND_POOL_ID: $BLEND_POOL_ID"
  echo "  USDC_ID:       $USDC_ID"
  echo ""
  echo "This submits real transactions against real funds and cannot be undone:"
  echo "adapters have no in-place upgrade path."
  echo ""
  CONFIRMATION=""
  # `|| true` so a closed or non-interactive stdin (EOF) doesn't trip `set -e`
  # and exit here with a bare shell failure instead of the clear abort message
  # below; an empty CONFIRMATION still correctly fails the check that follows.
  read -r -p "Type MAINNET to confirm and proceed: " CONFIRMATION || true
  if [ "$CONFIRMATION" != "MAINNET" ]; then
    echo "Confirmation not given. Aborting without submitting anything." >&2
    exit 1
  fi
fi

echo "Building blend-adapter for $NETWORK..."
cd "$(dirname "$0")/../packages/contracts"
stellar contract build

# `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
WASM_ADAPTER="target/wasm32v1-none/release/meridian_blend_adapter.wasm"

echo "Uploading blend-adapter WASM..."
ADAPTER_HASH=$(stellar contract upload \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm "$WASM_ADAPTER")
echo "blend-adapter WASM hash: $ADAPTER_HASH"

# vault/pool/USDC are constructor arguments, so they are set inside this same
# CreateContract operation. There is deliberately no separate initialize()
# step: that gap was front-runnable (#505).
echo "Deploying new adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
ADAPTER_ID=$(stellar contract deploy \
  --network "$NETWORK" \
  --source "$DEPLOYER" \
  --wasm-hash "$ADAPTER_HASH" \
  -- \
  --vault "$VAULT_ID" \
  --pool "$BLEND_POOL_ID" \
  --usdc "$USDC_ID")
echo "new adapter contract ID: $ADAPTER_ID"

echo ""
echo "New adapter deployed and wired at: $ADAPTER_ID"
echo "It is NOT yet live. The vault ($VAULT_ID) still points at its old adapter."
echo ""
echo "Check whether the vault has real depositors (query vault.get_total_shares)."
echo ""
echo "If it has depositors, use migrate_adapter (requires DEPLOYER to be the"
echo "vault's admin). It moves the vault's entire position to the new adapter"
echo "atomically, checked against a slippage tolerance in basis points:"
echo ""
echo "  stellar contract invoke \\"
echo "    --network $NETWORK \\"
echo "    --source \$DEPLOYER \\"
echo "    --id $VAULT_ID \\"
echo "    -- migrate_adapter --new-adapter $ADAPTER_ID --max-slippage-bps 100"
echo ""
echo "If it has no depositors yet (get_total_shares == 0), set_adapter is"
echo "simpler and sufficient (requires DEPLOYER to be the vault's admin):"
echo ""
echo "  stellar contract invoke \\"
echo "    --network $NETWORK \\"
echo "    --source \$DEPLOYER \\"
echo "    --id $VAULT_ID \\"
echo "    -- set_adapter --new-adapter $ADAPTER_ID"
echo ""
echo "This step is deliberately not run automatically."
