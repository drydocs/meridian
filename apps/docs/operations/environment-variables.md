# Environment Variables

## Web (`apps/web`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VITE_API_URL` | No | `""` | Base URL of the API server. Empty means same origin. In local dev, Vite proxies `/api` to `localhost:3001` so this is not needed. |

## API: serverless (`api/v1/`) and Fastify (`apps/api`)

| Variable | Required | Default | Description |
|---|---|---|---|
| `VAULT_CONTRACT_ID` | Yes (for tx routes) | `""` | Deployed `MeridianVault` contract address on Stellar. Without this, deposit and withdraw return 500 "Vault contract not yet deployed". |
| `PORT` | No | `3001` | Fastify server port (local dev only). |
| `ALLOWED_ORIGIN` | No | `"*"` | CORS allowed origin for the Fastify server. Set to your frontend domain in production if running Fastify as a standalone server. |

## Vercel

Set environment variables in the Vercel dashboard under **Project Settings > Environment Variables**, or via the CLI:

```bash
vercel env add VAULT_CONTRACT_ID
```

Variables prefixed with `VITE_` are inlined at build time and exposed to the browser. Do not put secrets in `VITE_` variables.

## Local development

Create `.env` files at the package level if needed:

```bash
# apps/api/.env
PORT=3001
VAULT_CONTRACT_ID=C...   # optional, leave empty if contract not yet deployed
```

The Fastify server loads `.env` via the `dotenv` package on startup.

## Future variables

| Variable | Purpose |
|---|---|
| `STELLAR_NETWORK` | Switch between `testnet` and `mainnet`. Currently hardcoded to testnet. |
| `REDIS_URL` | If Redis caching is added back to the API layer. Currently not used. |
