import { defaultConfig } from 'vitest/config';
import type { VitestConfig } from 'vitest';

const config: VitestConfig = {
  test: {
    coverage: {
      reporter: ['text', 'html'],
      reporter: ['text', 'html'],
      lines: 80,
      branches: 80,
      functions: 80,
      statements: 80,
    },
  },
};

export default config;