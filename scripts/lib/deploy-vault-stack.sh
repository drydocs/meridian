# Shared vault + BlendAdapter + mUSDC deployment orchestration for
# scripts/deploy-testnet.sh and scripts/deploy-mainnet.sh (#717).
#
# Extracted because the constructor-argument wiring below has changed three
# times already for front-running fixes (#505, #550, #551): keeping two
# independent copies of it risked the mainnet script silently deploying with
# stale wiring, or failing mid-sequence with blend-adapter/mUSDC already
# permanently wired to the wrong vault address, the next time either
# contract's constructor changes and only one copy gets updated.
#
# Sourced, not executed directly. The caller must set these before sourcing:
#
#   STELLAR_NETWORK_FLAGS  Array of stellar-cli network flags, e.g.
#                          (--network testnet) or
#                          (--rpc-url "$RPC_URL" --network-passphrase "$NETWORK_PASSPHRASE").
#   DEPLOYMENT_NETWORK     Manifest network key: testnet or mainnet.
#   DEPLOYER               Stellar secret key/alias that funds and signs the
#                          blend-adapter/mUSDC deploys.
#   ADMIN_ADDRESS          Vault admin public key (G...).
#   ADMIN_KEY              Signing key for ADMIN_ADDRESS, or "" if
#                          unavailable. When empty, deploy_vault_stack still
#                          deploys blend-adapter/mUSDC (wired to the vault's
#                          precomputed address) but leaves the vault itself
#                          undeployed and prints the command for ADMIN's
#                          holder to run themselves, matching
#                          deploy-testnet.sh's original fallback behavior.
#                          deploy-mainnet.sh hard-requires ADMIN_KEY to be
#                          set before it ever sources this file, so that
#                          fallback is dead code there, not a mainnet-unsafe
#                          convenience reintroduced through the back door.
#   TREASURY_ADDRESS       Dedicated address that receives performance-fee
#                          mUSDC. Constructor-fixed for this deployment.
#   USDC_ID                USDC contract address to wire the adapter to.
#   BLEND_POOL_ID          Blend pool contract address to wire the adapter to.
#   VAULT_SALT             Optional. Reuse the salt printed by a previous
#                          failed run to resume at the same reserved vault
#                          address instead of stranding its already-deployed
#                          blend-adapter/mUSDC. Leave unset for a fresh
#                          deploy: a random salt is generated and printed.
#   SKIP_BUILD             Optional. Set (to any value) to skip `stellar
#                          contract build` and use the WASM already present
#                          in packages/contracts/target/wasm32v1-none/release
#                          as-is. For deploying a build already verified
#                          elsewhere (e.g. downloaded from a genuine Linux CI
#                          build) without this script's own build silently
#                          overwriting it with a locally-built one first.
#
# After sourcing, call deploy_vault_stack. It sets VAULT_ID, BLEND_ADAPTER_ID,
# MUSDC_ID, and VAULT_INITIALIZED (1 if the vault itself was deployed this
# run, 0 if the ADMIN_KEY-empty fallback above was taken) as globals. A
# completed deployment also updates packages/shared/deployed-contracts.json.

upload() {
  stellar contract upload "${STELLAR_NETWORK_FLAGS[@]}" --source "$DEPLOYER" --wasm "$1"
}
# The second argument is a salt (pass "" for none, letting the CLI pick one),
# used by the vault deploy below to land at a precomputed address. The third
# is the signing/source identity: DEPLOYER for blend-adapter/mUSDC, which
# need no human auth, or ADMIN_KEY for the vault, whose constructor requires
# ADMIN's own auth. Any arguments after `--` are forwarded to
# `stellar contract deploy` as constructor arguments:
# `deploy "$hash" "" "$DEPLOYER" -- --a 1`.
deploy() {
  local hash="$1"
  local salt="$2"
  local source="$3"
  local stderr_file
  local output
  local contract_id
  local transaction_hash
  shift 3
  stderr_file=$(mktemp)
  if [ -n "$salt" ]; then
    if ! output=$(stellar contract deploy "${STELLAR_NETWORK_FLAGS[@]}" --source "$source" --wasm-hash "$hash" --salt "$salt" "$@" 2>"$stderr_file"); then
      cat "$stderr_file" >&2
      rm -f "$stderr_file"
      return 1
    fi
  else
    if ! output=$(stellar contract deploy "${STELLAR_NETWORK_FLAGS[@]}" --source "$source" --wasm-hash "$hash" "$@" 2>"$stderr_file"); then
      cat "$stderr_file" >&2
      rm -f "$stderr_file"
      return 1
    fi
  fi

  cat "$stderr_file" >&2
  contract_id=$(printf '%s\n' "$output" | sed -nE '/^C[A-Z2-7]{55}$/p' | tail -n 1)
  transaction_hash=$(
    {
      printf '%s\n' "$output"
      cat "$stderr_file"
    } | sed -nE 's#.*\/tx\/([0-9a-fA-F]{64}).*#\1#p' | tail -n 1 | tr '[:upper:]' '[:lower:]'
  )
  rm -f "$stderr_file"
  if [ -z "$contract_id" ] || [ -z "$transaction_hash" ]; then
    echo "ERROR: stellar-cli did not return a contract ID and deployment transaction hash." >&2
    return 1
  fi
  printf '%s|%s\n' "$contract_id" "$transaction_hash"
}

deploy_vault_stack() {
  local repo_root
  repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
  : "${DEPLOYMENT_NETWORK:?DEPLOYMENT_NETWORK must be testnet or mainnet}"
  if [ "$DEPLOYMENT_NETWORK" != "testnet" ] && [ "$DEPLOYMENT_NETWORK" != "mainnet" ]; then
    echo "ERROR: DEPLOYMENT_NETWORK must be testnet or mainnet." >&2
    return 1
  fi

  local expected_stellar_cli_version
  expected_stellar_cli_version=$(node -e '
    const fs = require("node:fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(manifest.toolchain.stellarCli);
  ' "$repo_root/packages/shared/deployed-contracts.json")
  local stellar_version_output
  if ! stellar_version_output=$(stellar --version 2>&1); then
    echo "ERROR: unable to read the installed Stellar CLI version." >&2
    printf '%s\n' "$stellar_version_output" >&2
    return 1
  fi
  local actual_stellar_cli_version
  actual_stellar_cli_version=$(printf '%s\n' "$stellar_version_output" | sed -nE 's/^[^0-9]*([0-9]+\.[0-9]+\.[0-9]+).*/\1/p')
  if [ "$actual_stellar_cli_version" != "$expected_stellar_cli_version" ]; then
    echo "ERROR: deployment manifest requires Stellar CLI $expected_stellar_cli_version, but found: $stellar_version_output" >&2
    return 1
  fi

  if [ -n "$(git -C "$repo_root" status --porcelain --untracked-files=all -- packages/contracts)" ]; then
    echo "ERROR: packages/contracts has uncommitted changes; commit them before deployment." >&2
    return 1
  fi

  local vault_salt="${VAULT_SALT:-$(openssl rand -hex 32)}"
  local blend_adapter_salt="${BLEND_ADAPTER_SALT:-$(openssl rand -hex 32)}"
  local musdc_salt="${MUSDC_SALT:-$(openssl rand -hex 32)}"
  VAULT_ID=$(stellar contract id wasm "${STELLAR_NETWORK_FLAGS[@]}" --source-account "$ADMIN_ADDRESS" --salt "$vault_salt")
  BLEND_ADAPTER_ID=$(stellar contract id wasm "${STELLAR_NETWORK_FLAGS[@]}" --source-account "$DEPLOYER_ADDRESS" --salt "$blend_adapter_salt")
  MUSDC_ID=$(stellar contract id wasm "${STELLAR_NETWORK_FLAGS[@]}" --source-account "$DEPLOYER_ADDRESS" --salt "$musdc_salt")

  local zero_account="GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
  local address
  for address in "$ADMIN_ADDRESS" "$USDC_ID" "$TREASURY_ADDRESS" "$BLEND_POOL_ID"; do
    if [[ ! "$address" =~ ^[GC][A-Z2-7]{55}$ ]] || [ "$address" = "$zero_account" ]; then
      echo "ERROR: invalid or zero deployment address: $address" >&2
      return 1
    fi
  done
  if [ "$ADMIN_ADDRESS" = "$VAULT_ID" ] || [ "$USDC_ID" = "$VAULT_ID" ] ||
    [ "$TREASURY_ADDRESS" = "$VAULT_ID" ] || [ "$BLEND_ADAPTER_ID" = "$VAULT_ID" ] ||
    [ "$MUSDC_ID" = "$VAULT_ID" ]; then
    echo "ERROR: admin, USDC, mUSDC, adapter, and treasury must not alias the vault address ($VAULT_ID)." >&2
    return 1
  fi
  cd "$repo_root/packages/contracts"
  # SKIP_BUILD lets a caller drop in WASM already verified elsewhere (e.g. a
  # genuine Linux CI build, downloaded to sidestep `stellar contract build`'s
  # non-reproducibility across platforms) without this rebuilding over it
  # locally. Unset by default: a normal run always builds from source here.
  if [ -z "${SKIP_BUILD:-}" ]; then
    echo "Building contracts..."
    stellar contract build
  else
    echo "Skipping build (SKIP_BUILD set); using WASM already in target/wasm32v1-none/release."
  fi

  # `stellar contract build` targets wasm32v1-none, not wasm32-unknown-unknown.
  local wasm_dir="target/wasm32v1-none/release"
  local wasm_vault="$wasm_dir/meridian_vault.wasm"
  local wasm_blend_adapter="$wasm_dir/meridian_blend_adapter.wasm"
  local wasm_musdc_token="$wasm_dir/meridian_musdc_token.wasm"

  echo "Uploading vault WASM..."
  local vault_hash
  vault_hash=$(upload "$wasm_vault")
  echo "Uploading blend-adapter WASM..."
  local blend_adapter_hash
  blend_adapter_hash=$(upload "$wasm_blend_adapter")
  echo "Uploading mUSDC token WASM..."
  local musdc_token_hash
  musdc_token_hash=$(upload "$wasm_musdc_token")

  # The vault takes admin/usdc/musdc/adapter/treasury as constructor arguments (#551,
  # same fix #505/#550 already applied to the adapters/mUSDC), so its state
  # is set inside its own deploying transaction with no intervening ledger
  # for a front-run to land in. But blend-adapter and mUSDC's own
  # constructors need the vault's address, and the vault won't exist to
  # hand out an address until it is deployed. Soroban contract IDs are
  # deterministic from (network, source account, salt) alone, independent
  # of the wasm being deployed, so a random salt lets the vault's address
  # be computed up front, handed to blend-adapter/mUSDC, and then the vault
  # is deployed to that exact same address with a matching --salt. The
  # source account used here must be ADMIN_ADDRESS, since it must match
  # whoever actually sources the vault's own deploy below.
  # Generated fresh on every run and never persisted, so a run that fails
  # after this point (e.g. blend-adapter or mUSDC deploys below) used to
  # strand those contracts permanently: the vault address they were wired to
  # could never be deployed to again once the salt that produced it was
  # gone. VAULT_SALT lets a retry after a partial failure reuse the exact
  # same salt (and therefore the same reserved VAULT_ID) so blend-adapter
  # and mUSDC deploys already on-chain from the failed run stay usable
  # instead of being orphaned. Always echoed below so it can be recovered
  # from terminal scrollback even if the caller didn't set it.
  echo "VAULT_SALT (save this: re-run with VAULT_SALT=$vault_salt to resume at the same address if this run fails partway): $vault_salt"
  echo "BLEND_ADAPTER_SALT: $blend_adapter_salt"
  echo "MUSDC_SALT: $musdc_salt"
  echo "Reserved vault contract ID: $VAULT_ID"

  # The adapter's vault/pool/USDC wiring is passed as constructor arguments,
  # so it is set inside this same CreateContract operation. There is
  # deliberately no separate initialize() step: that gap was front-runnable
  # (#505).
  echo "Deploying blend-adapter (vault=$VAULT_ID, pool=$BLEND_POOL_ID, usdc=$USDC_ID)..."
  local blend_adapter_result
  local blend_adapter_tx
  blend_adapter_result=$(deploy "$blend_adapter_hash" "$blend_adapter_salt" "$DEPLOYER" \
    -- --vault "$VAULT_ID" --pool "$BLEND_POOL_ID" --usdc "$USDC_ID") || return 1
  IFS='|' read -r BLEND_ADAPTER_ID blend_adapter_tx <<< "$blend_adapter_result"
  echo "blend-adapter contract ID: $BLEND_ADAPTER_ID"

  # mUSDC (#578) is a custom SEP-41 token, not a Stellar Asset Contract: it
  # carries a transfer callback into the vault so cost basis and entry time
  # split correctly between sender and receiver on a transfer, which a bare
  # SAC has no hook to support. Its admin ($VAULT_ID) is passed as a
  # constructor argument for the same reason as blend-adapter's own wiring
  # above: initialize() has no identity to authorize against yet, so a
  # deploy-then-initialize gap would be front-runnable the same way #505's
  # adapter gap was.
  echo "Deploying mUSDC token (admin=$VAULT_ID)..."
  local musdc_result
  local musdc_tx
  musdc_result=$(deploy "$musdc_token_hash" "$musdc_salt" "$DEPLOYER" \
    -- --admin "$VAULT_ID" --decimals 7 --name "Meridian USDC" --symbol mUSDC) || return 1
  IFS='|' read -r MUSDC_ID musdc_tx <<< "$musdc_result"
  echo "mUSDC contract ID: $MUSDC_ID"

  # Read back the deployed wiring before submitting the vault transaction.
  # This prevents a fee-spending mismatch from reaching the vault deploy.
  local adapter_usdc
  local adapter_vault
  local musdc_admin
  if ! adapter_usdc=$(stellar contract invoke "${STELLAR_NETWORK_FLAGS[@]}" --source "$DEPLOYER" \
    --id "$BLEND_ADAPTER_ID" -- get_usdc 2>&1 | tr -d '[:space:]"\r'); then
    echo "ERROR: unable to read the deployed adapter USDC binding." >&2
    return 1
  fi
  if ! adapter_vault=$(stellar contract invoke "${STELLAR_NETWORK_FLAGS[@]}" --source "$DEPLOYER" \
    --id "$BLEND_ADAPTER_ID" -- get_vault 2>&1 | tr -d '[:space:]"\r'); then
    echo "ERROR: unable to read the deployed adapter vault binding." >&2
    return 1
  fi
  if ! musdc_admin=$(stellar contract invoke "${STELLAR_NETWORK_FLAGS[@]}" --source "$DEPLOYER" \
    --id "$MUSDC_ID" -- admin 2>&1 | tr -d '[:space:]"\r'); then
    echo "ERROR: unable to read the deployed mUSDC admin." >&2
    return 1
  fi
  if [[ "$adapter_usdc" != *"$USDC_ID"* ]]; then
    echo "ERROR: adapter USDC binding mismatch: expected $USDC_ID, got $adapter_usdc." >&2
    return 1
  fi
  if [[ "$adapter_vault" != *"$VAULT_ID"* ]]; then
    echo "ERROR: adapter vault binding mismatch: expected $VAULT_ID, got $adapter_vault." >&2
    return 1
  fi
  if [[ "$musdc_admin" != *"$VAULT_ID"* ]]; then
    echo "ERROR: mUSDC admin mismatch: expected $VAULT_ID, got $musdc_admin." >&2
    return 1
  fi

  # Deploying with the same salt used to reserve VAULT_ID above lands the
  # vault at that exact address. Its constructor sets
  # admin/usdc/musdc/adapter/treasury in this same transaction and requires
  # admin.require_auth(), which Soroban only honors here for the
  # transaction's own source account, so this must be sourced by ADMIN_KEY,
  # not DEPLOYER.
  VAULT_INITIALIZED=0
  if [ -n "$ADMIN_KEY" ]; then
    echo "Deploying vault (admin=$ADMIN_ADDRESS, treasury=$TREASURY_ADDRESS, usdc=$USDC_ID, musdc=$MUSDC_ID, adapter=$BLEND_ADAPTER_ID)..."
    local actual_vault_id
    local vault_result
    local vault_tx
    vault_result=$(deploy "$vault_hash" "$vault_salt" "$ADMIN_KEY" \
      -- --admin "$ADMIN_ADDRESS" --usdc "$USDC_ID" --musdc "$MUSDC_ID" --adapter "$BLEND_ADAPTER_ID" --treasury "$TREASURY_ADDRESS") || return 1
    IFS='|' read -r actual_vault_id vault_tx <<< "$vault_result"

    # blend-adapter and mUSDC above were already deployed with VAULT_ID
    # baked permanently into their constructor state, and neither has an
    # in-place upgrade path. This should never fail (the same source
    # account and salt computed VAULT_ID and are used again here), but if
    # it ever did, silently trusting the precomputed address instead of
    # checking would leave both permanently wired to a vault address that
    # isn't the one actually deployed.
    if [ "$actual_vault_id" != "$VAULT_ID" ]; then
      echo "ERROR: vault deployed to $actual_vault_id, but blend-adapter and mUSDC" >&2
      echo "were already wired to the precomputed address $VAULT_ID." >&2
      exit 1
    fi
    echo "vault contract ID: $VAULT_ID"
    VAULT_INITIALIZED=1

    "$repo_root/node_modules/.bin/tsx" "$repo_root/scripts/write-deployment-manifest.ts" \
      --network "$DEPLOYMENT_NETWORK" \
      --vault-address "$VAULT_ID" --vault-hash "$vault_hash" --vault-salt "$vault_salt" --vault-tx "$vault_tx" \
      --blend-address "$BLEND_ADAPTER_ID" --blend-hash "$blend_adapter_hash" --blend-salt "$blend_adapter_salt" --blend-tx "$blend_adapter_tx" \
      --musdc-address "$MUSDC_ID" --musdc-hash "$musdc_token_hash" --musdc-salt "$musdc_salt" --musdc-tx "$musdc_tx" \
      --admin "$ADMIN_ADDRESS" --treasury "$TREASURY_ADDRESS" --usdc "$USDC_ID" --blend-pool "$BLEND_POOL_ID"
  else
    # ADMIN is separate from DEPLOYER and ADMIN_KEY was not supplied, so
    # this run has no key that can source the vault's deploy transaction
    # and satisfy its constructor's admin.require_auth(). Unlike the old
    # deploy-then-initialize() flow, there is no claimable window: the
    # vault simply does not exist on-chain yet. Run this command as the
    # ADMIN key holder to complete the deployment, using the exact salt
    # below.
    echo ""
    echo "blend-adapter and mUSDC are deployed and wired to the vault's reserved"
    echo "address ($VAULT_ID), but the vault itself is NOT YET DEPLOYED."
    echo ""
    echo "ADMIN ($ADMIN_ADDRESS) is separate from DEPLOYER and ADMIN_KEY was not"
    echo "set, so this run has no key that can source the vault's deploy"
    echo "transaction. Run this as the ADMIN key holder, using this exact salt"
    echo "(a different salt lands at a different address than blend-adapter and"
    echo "mUSDC are already wired to):"
    echo ""
    echo "  stellar contract deploy ${STELLAR_NETWORK_FLAGS[*]} --source <your-ADMIN-key-or-alias> \\"
    echo "    --wasm-hash $vault_hash --salt $vault_salt \\"
    echo "    -- --admin $ADMIN_ADDRESS --usdc $USDC_ID --musdc $MUSDC_ID --adapter $BLEND_ADAPTER_ID --treasury $TREASURY_ADDRESS"
    echo ""
  fi
}
