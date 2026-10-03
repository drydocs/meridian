import type { SimulationTimestamp } from "./types";

export class InvalidClockConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidClockConfigError";
  }
}

export interface SimulationClockConfig {
  /** First simulated instant, in epoch milliseconds. */
  start: SimulationTimestamp;
  /** Last simulated instant, in epoch milliseconds (inclusive). */
  end: SimulationTimestamp;
  /** Fixed step between ticks, in milliseconds. */
  stepMs: number;
}

export const ONE_HOUR_MS = 3_600_000;
export const ONE_DAY_MS = 86_400_000;

/**
 * Deterministic simulation clock.
 *
 * Time is a pure function of (start, end, stepMs) and the number of steps
 * taken; the clock never reads wall-clock time. Ticks are placed at
 * `start`, `start + stepMs`, ..., `end` (both ends inclusive).
 *
 * Boundary behavior: `stepMs` must divide `end - start` exactly. A window
 * with a trailing partial step is rejected with `InvalidClockConfigError`
 * rather than truncated, so a run can never silently stop short of `end`.
 */
export class SimulationClock {
  readonly start: SimulationTimestamp;
  readonly end: SimulationTimestamp;
  readonly stepMs: number;
  /** Number of advances from start to end, i.e. `(end - start) / stepMs`. */
  readonly stepCount: number;
  #index = 0;

  constructor(config: SimulationClockConfig) {
    const { start, end, stepMs } = config;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new InvalidClockConfigError(
        "start and end must be integer millisecond timestamps"
      );
    }
    if (!Number.isSafeInteger(stepMs) || stepMs <= 0) {
      throw new InvalidClockConfigError("stepMs must be a positive integer");
    }
    if (end < start) {
      throw new InvalidClockConfigError("end must not be before start");
    }
    const window = end - start;
    if (window % stepMs !== 0) {
      throw new InvalidClockConfigError(
        `stepMs ${stepMs} does not divide the window of ${window} ms evenly`
      );
    }
    this.start = start;
    this.end = end;
    this.stepMs = stepMs;
    this.stepCount = window / stepMs;
  }

  /** Total number of timestamps a full run visits (`stepCount + 1`). */
  get tickCount(): number {
    return this.stepCount + 1;
  }

  /** Zero-based index of the current tick. */
  get index(): number {
    return this.#index;
  }

  /** Current simulated timestamp. */
  get now(): SimulationTimestamp {
    return this.start + this.#index * this.stepMs;
  }

  get isFinished(): boolean {
    return this.#index >= this.stepCount;
  }

  /**
   * Advance one step and return the new timestamp, or `null` (without
   * moving) if the clock is already at `end`.
   */
  advance(): SimulationTimestamp | null {
    if (this.isFinished) return null;
    this.#index += 1;
    return this.now;
  }

  reset(): void {
    this.#index = 0;
  }

  /** Timestamp of tick `index` (0..stepCount), independent of clock state. */
  timestampAt(index: number): SimulationTimestamp {
    if (!Number.isInteger(index) || index < 0 || index > this.stepCount) {
      throw new RangeError(
        `tick index ${index} outside [0, ${this.stepCount}]`
      );
    }
    return this.start + index * this.stepMs;
  }

  /** Iterate every tick from start to end inclusive, without moving the clock. */
  *ticks(): IterableIterator<SimulationTimestamp> {
    for (let i = 0; i <= this.stepCount; i++) {
      yield this.start + i * this.stepMs;
    }
  }

  [Symbol.iterator](): IterableIterator<SimulationTimestamp> {
    return this.ticks();
  }
}
