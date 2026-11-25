export interface StartupAsset {
  file: string;
  type: "entry" | "modulepreload" | "static-import";
  path: string;
  size: number;
}

export interface InitialJsResult {
  assets: StartupAsset[];
  totalBytes: number;
}

export interface BundleReport {
  baseline: {
    initialJsBytes: number;
    description?: string;
  };
  budget: {
    maxInitialJsBytes: number;
    description?: string;
  };
  current?: {
    initialJsBytes: number;
    reductionPercent: number;
    chunks?: Record<string, string>;
  };
}

export interface GateEvaluation {
  passed: boolean;
  initialJsBytes: number;
  baselineBytes: number;
  budgetBytes: number;
  reductionPercent: number;
  error?: string;
}

export function getInitialJsAssets(webRoot?: string): InitialJsResult;
export function evaluateBundleBudget(
  report: BundleReport,
  initialJsBytes: number
): GateEvaluation;
export function runBundleCheck(options?: {
  webRoot?: string;
  reportPath?: string;
}): GateEvaluation;
