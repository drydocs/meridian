import { describe, it, expect, vi } from "vitest";
import {
  SimulationClock,
  InvalidClockConfigError,
  ONE_DAY_MS,
  ONE_HOUR_MS,
} from "./index";

const T0 = 1_700_000_000_000;

describe("SimulationClock", () => {
  it("produces hand-worked hourly timestamps and counts", () => {
    const clock = new SimulationClock({
      start: T0,
      end: T0 + 3 * ONE_HOUR_MS,
      stepMs: ONE_HOUR_MS,
    });
    expect(clock.stepCount).toBe(3);
    expect(clock.tickCount).toBe(4);
    expect([...clock]).toEqual([
      T0,
      T0 + ONE_HOUR_MS,
      T0 + 2 * ONE_HOUR_MS,
      T0 + 3 * ONE_HOUR_MS,
    ]);
  });

  it("counts daily steps over a 30 day window", () => {
    const clock = new SimulationClock({
      start: T0,
      end: T0 + 30 * ONE_DAY_MS,
      stepMs: ONE_DAY_MS,
    });
    expect(clock.stepCount).toBe(30);
    expect([...clock]).toHaveLength(31);
    expect(clock.timestampAt(30)).toBe(T0 + 30 * ONE_DAY_MS);
  });

  it("advances step by step and stops at end", () => {
    const clock = new SimulationClock({
      start: T0,
      end: T0 + 2 * ONE_HOUR_MS,
      stepMs: ONE_HOUR_MS,
    });
    expect(clock.now).toBe(T0);
    expect(clock.advance()).toBe(T0 + ONE_HOUR_MS);
    expect(clock.advance()).toBe(T0 + 2 * ONE_HOUR_MS);
    expect(clock.isFinished).toBe(true);
    expect(clock.advance()).toBeNull();
    expect(clock.now).toBe(T0 + 2 * ONE_HOUR_MS);
    clock.reset();
    expect(clock.now).toBe(T0);
    expect(clock.index).toBe(0);
  });

  it("is deterministic across runs and never reads wall-clock time", () => {
    const dateNow = vi.spyOn(Date, "now");
    const config = {
      start: T0,
      end: T0 + 10 * ONE_HOUR_MS,
      stepMs: 2 * ONE_HOUR_MS,
    };
    const a = [...new SimulationClock(config)];
    const b = [...new SimulationClock(config)];
    expect(a).toEqual(b);
    expect(dateNow).not.toHaveBeenCalled();
    dateNow.mockRestore();
  });

  it("supports a zero-length window as a single tick", () => {
    const clock = new SimulationClock({ start: T0, end: T0, stepMs: 1000 });
    expect(clock.stepCount).toBe(0);
    expect([...clock]).toEqual([T0]);
    expect(clock.isFinished).toBe(true);
  });

  it("rejects a step that leaves a final partial step", () => {
    expect(
      () =>
        new SimulationClock({
          start: T0,
          end: T0 + 2.5 * ONE_HOUR_MS,
          stepMs: ONE_HOUR_MS,
        })
    ).toThrow(InvalidClockConfigError);
  });

  it("rejects invalid configuration", () => {
    const bad = [
      { start: T0, end: T0 + 10, stepMs: 0 },
      { start: T0, end: T0 + 10, stepMs: -5 },
      { start: T0, end: T0 + 10, stepMs: 1.5 },
      { start: T0, end: T0 - 10, stepMs: 5 },
      { start: 1.5, end: 10, stepMs: 5 },
    ];
    for (const config of bad) {
      expect(() => new SimulationClock(config)).toThrow(
        InvalidClockConfigError
      );
    }
  });

  it("rejects out-of-range timestampAt indices", () => {
    const clock = new SimulationClock({ start: 0, end: 10, stepMs: 5 });
    expect(() => clock.timestampAt(3)).toThrow(RangeError);
    expect(() => clock.timestampAt(-1)).toThrow(RangeError);
  });
});
