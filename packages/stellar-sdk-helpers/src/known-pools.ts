export interface KnownPoolMeta {
  id: string;
  name: string;
  protocol: "blend" | "defindex";
  label: string;
}

export const KNOWN_POOLS: Record<string, KnownPoolMeta> = {
  "ecf788e3-d2ef-4fdd-9ece-8a2d96226ddf": { id: "blend-usdc-fixed",    name: "Blend Capital", protocol: "blend", label: "Fixed Rate"    },
  "3a61420f-6f6e-45f9-accc-8d23f5a32d33": { id: "blend-eurc-fixed",    name: "Blend Capital", protocol: "blend", label: "Fixed Rate"    },
  "48c597dc-9367-4b4a-aa10-49b9755c4c2e": { id: "blend-usdc-variable", name: "Blend Capital", protocol: "blend", label: "Variable Rate" },
  "9a2f1f81-0a6e-441d-8219-c13b3520bd57": { id: "blend-eurc-variable", name: "Blend Capital", protocol: "blend", label: "Variable Rate" },
} satisfies Record<string, KnownPoolMeta>;
