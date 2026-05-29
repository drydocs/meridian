# Introduction

Meridian is a stablecoin yield aggregator on the Stellar network. Users deposit USDC into a single vault and earn yield automatically, with Meridian routing their funds to whichever underlying protocol is currently offering the best rate.

## What it does

1. A user connects their Freighter wallet and deposits USDC.
2. Meridian compares live APY across supported protocols (currently Blend Capital and DeFindex).
3. The vault routes the deposit to the highest-yielding option, recorded on-chain at signing time so the user can verify the routing decision before approving.
4. The user receives mUSDC share tokens representing their position. Share price appreciates as yield accrues.
5. At any time the user can withdraw by burning their mUSDC shares, receiving USDC plus accumulated yield.

## What it does not do

- Meridian never holds or controls private keys. The server builds an unsigned transaction and returns it to the browser; the user signs with Freighter.
- Meridian does not custody funds. The vault contract on Stellar holds USDC and mUSDC is a standard Stellar asset.
- Meridian does not guarantee yield. APY figures are live estimates from on-chain data and DeFiLlama. Past rates do not predict future rates.

## Status

Meridian is in active development on Stellar testnet. The vault contract, XDR builder, and frontend are implemented. Testnet deployment and end-to-end signing are the next milestones before mainnet.
