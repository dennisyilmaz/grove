import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import {
  concurrency,
  daySpendCap,
  deadlineMs,
  localDay,
  numericSetting,
  sessionRestartLimit,
  taskSpendCap,
  turnLimit,
} from "../src/orchestrator/limits.ts";

const config = loadConfig({});
const reader = (values: Record<string, string>) => (key: string) => values[key] ?? null;

describe("numericSetting", () => {
  it("takes a valid positive number from settings", () => {
    expect(numericSetting(reader({ k: "42" }), "k", 7)).toBe(42);
    expect(numericSetting(reader({ k: " 1.5 " }), "k", 7)).toBe(1.5);
  });

  it("falls back to the default for every malformed value", () => {
    // The direction is the point: a human's typo must never be read as
    // "no limit". Each of these was a ceiling someone could have removed.
    for (const bad of ["", "   ", "none", "off", "abc", "0", "-5", "NaN", "Infinity", "1e999"]) {
      expect(numericSetting(reader({ k: bad }), "k", 7), `for ${JSON.stringify(bad)}`).toBe(7);
    }
  });

  it("falls back when the key is absent", () => {
    expect(numericSetting(reader({}), "k", 7)).toBe(7);
  });
});

describe("per-role ceilings", () => {
  it("uses the config default when no setting exists", () => {
    expect(turnLimit(reader({}), config, "worker")).toBe(config.sessionMaxTurns.worker);
    expect(deadlineMs(reader({}), config, "reviewer")).toBe(config.sessionDeadlineMs.reviewer);
  });

  it("lets a setting move one role without touching the others", () => {
    const get = reader({ "limits.maxTurns.worker": "10" });
    expect(turnLimit(get, config, "worker")).toBe(10);
    expect(turnLimit(get, config, "planner")).toBe(config.sessionMaxTurns.planner);
  });

  it("floors fractional turn and deadline values", () => {
    expect(turnLimit(reader({ "limits.maxTurns.worker": "10.9" }), config, "worker")).toBe(10);
  });
});

describe("spend caps", () => {
  it("resolves task → global → config, most specific first", () => {
    expect(taskSpendCap(reader({}), config, "task_1")).toBe(config.maxTaskSpendUsd);
    expect(taskSpendCap(reader({ "limits.spend.task": "5" }), config, "task_1")).toBe(5);
    expect(
      taskSpendCap(
        reader({ "limits.spend.task": "5", "limits.spend.task.task_1": "50" }),
        config,
        "task_1",
      ),
    ).toBe(50);
  });

  it("keeps a raised per-task ceiling off every other task", () => {
    const get = reader({ "limits.spend.task.task_1": "999" });
    expect(taskSpendCap(get, config, "task_1")).toBe(999);
    expect(taskSpendCap(get, config, "task_2")).toBe(config.maxTaskSpendUsd);
  });

  it("resolves the daily cap per day", () => {
    const get = reader({ "limits.spend.day.2026-07-29": "7" });
    expect(daySpendCap(get, config, "2026-07-29")).toBe(7);
    expect(daySpendCap(get, config, "2026-07-30")).toBe(config.maxDailySpendUsd);
  });
});

describe("localDay", () => {
  it("formats the operator's local date, not UTC", () => {
    // 23:30 local on the 29th is the 30th in UTC for a positive offset; the
    // ledger must agree with the clock the human is reading.
    const d = new Date(2026, 6, 29, 23, 30, 0);
    expect(localDay(d)).toBe("2026-07-29");
  });

  it("zero-pads month and day", () => {
    expect(localDay(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

describe("other limits", () => {
  it("resolves concurrency from settings", () => {
    const get = reader({ "limits.maxConcurrentTasks": "6" });
    expect(concurrency(get, config).maxConcurrentTasks).toBe(6);
    expect(concurrency(get, config).maxWorkersPerTask).toBe(config.maxWorkersPerTask);
  });

  it("resolves the session restart allowance, and honours zero", () => {
    expect(sessionRestartLimit(reader({}), config)).toBe(config.sessionRestarts);
    // "never restart, tell me instead" is a coherent choice, so 0 is a value
    // here — unlike a 0 turn ceiling, which would just be a broken session.
    expect(sessionRestartLimit(reader({ "limits.sessionRestarts": "0" }), config)).toBe(0);
    expect(sessionRestartLimit(reader({ "limits.sessionRestarts": "-1" }), config)).toBe(
      config.sessionRestarts,
    );
  });
});
