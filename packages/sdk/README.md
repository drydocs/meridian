# @meridian/sdk

The Meridian SDK package provides typed, runtime-safe building blocks for
applications integrating with Meridian vaults and strategies.

## Installation

```sh
pnpm add @meridian/sdk @stellar/stellar-sdk
```

The package publishes both ESM and CommonJS builds, plus generated TypeScript
declarations. The package is currently version `0.1.0` while the public SDK
surface is being established.

```ts
import { getSdkInfo } from "@meridian/sdk";

console.log(getSdkInfo());
```
