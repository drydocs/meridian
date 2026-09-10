<template>
  <div
    class="hero-apy-chart"
    role="img"
    aria-label="Animated line chart illustrating APY tracked live"
  >
    <svg viewBox="0 0 260 130" class="chart-svg">
      <defs>
        <linearGradient id="heroApyLine" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stop-color="#3b82f6" />
          <stop offset="100%" stop-color="#10b981" />
        </linearGradient>
        <linearGradient id="heroApyFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10b981" stop-opacity="0.35" />
          <stop offset="100%" stop-color="#10b981" stop-opacity="0" />
        </linearGradient>
      </defs>
      <line class="chart-grid" x1="0" y1="110" x2="260" y2="110" />
      <path
        class="chart-fill"
        d="M6 100 C 60 96, 90 78, 130 66 C 170 54, 200 40, 254 18 L254 110 L6 110 Z"
      />
      <path
        class="chart-line"
        d="M6 100 C 60 96, 90 78, 130 66 C 170 54, 200 40, 254 18"
      />
      <circle class="chart-dot" cx="254" cy="18" />
    </svg>
    <p class="chart-label">APY tracking <span class="chart-live">live</span></p>
  </div>
</template>

<style scoped>
.hero-apy-chart {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.chart-svg {
  width: 260px;
  height: 130px;
  overflow: visible;
}

.chart-grid {
  stroke: var(--vp-c-divider);
  stroke-width: 1;
}

.chart-line {
  fill: none;
  stroke: url(#heroApyLine);
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-dasharray: 220;
  stroke-dashoffset: 220;
  animation: hero-apy-draw 2.4s ease-out infinite;
}

.chart-fill {
  fill: url(#heroApyFill);
  opacity: 0;
  animation: hero-apy-fill 2.4s ease-out infinite;
}

.chart-dot {
  fill: #10b981;
  opacity: 0;
  animation: hero-apy-dot 2.4s ease-out infinite;
}

.chart-label {
  font-size: 15px;
  font-weight: 600;
  color: var(--vp-c-text-1);
  font-variant-numeric: tabular-nums;
}

.chart-live {
  color: #10b981;
}

@keyframes hero-apy-draw {
  0% {
    stroke-dashoffset: 220;
  }
  55%,
  100% {
    stroke-dashoffset: 0;
  }
}

@keyframes hero-apy-fill {
  0%,
  50% {
    opacity: 0;
  }
  60%,
  100% {
    opacity: 1;
  }
}

@keyframes hero-apy-dot {
  0%,
  52% {
    opacity: 0;
    r: 0;
  }
  58% {
    opacity: 1;
    r: 5;
  }
  62%,
  100% {
    opacity: 1;
    r: 3.5;
  }
}

@media (prefers-reduced-motion: reduce) {
  .chart-line,
  .chart-fill,
  .chart-dot {
    animation: none;
  }
  .chart-line {
    stroke-dashoffset: 0;
  }
  .chart-fill {
    opacity: 1;
  }
  .chart-dot {
    opacity: 1;
    r: 3.5;
  }
}
</style>
