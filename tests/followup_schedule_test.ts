import assert from "node:assert/strict";
import {
  nextScheduleWindow,
  type ScheduleConfig,
  scheduleWindow,
} from "../src/followup_schedule.ts";
const config: ScheduleConfig = {
  timezone: "Europe/Lisbon",
  windows: ["08:00", "20:00"],
  duration_ms: 5400000,
  max_attempts: 2,
};
const ms = Date.parse;
Deno.test("schedule: Lisbon winter/summer and both DST transitions", () => {
  for (
    const [day, hour] of [["2026-01-10", "08"], ["2026-07-10", "07"], ["2026-03-29", "07"], [
      "2026-10-25",
      "08",
    ]]
  ) {
    const t = ms(day + "T" + hour + ":00:00Z"), start = t - 86400000, end = t + 86400000;
    assert.equal(scheduleWindow(t - 1, start, end, config), null);
    assert.equal(scheduleWindow(t, start, end, config)?.starts_at, t);
    assert.equal(scheduleWindow(t + 5399999, start, end, config)?.ends_at, t + 5400000);
    assert.equal(scheduleWindow(t + 5400000, start, end, config), null);
    assert.equal(nextScheduleWindow(t + 5400000, start, end, config), t + 43200000);
  }
});
Deno.test("schedule: finite expiry, activation inside window, no backlog", () => {
  const t = ms("2026-10-08T07:00:00Z");
  assert.equal(scheduleWindow(t, t + 1000, t + 10000, config), null);
  assert.equal(scheduleWindow(t + 1000, t + 1000, t + 10000, config)?.ends_at, t + 10000);
  assert.equal(scheduleWindow(t + 10000, t + 1000, t + 10000, config), null);
  assert.equal(nextScheduleWindow(t + 20000, t + 1000, t + 10000, config), null);
  assert.equal(scheduleWindow(t + 36000000, t, t + 86400000, config), null);
});
Deno.test("schedule: invalid/overlapping input and DST nonexistent/duplicated hour", () => {
  const t = ms("2026-03-29T00:00:00Z");
  for (
    const patch of [{ timezone: "invalid" }, { windows: ["24:00"] }, {
      windows: ["08:00", "08:30"],
    }, { max_attempts: 0 }]
  ) assert.throws(() => scheduleWindow(t, t, t + 86400000, { ...config, ...patch }));
  const gap = { ...config, windows: ["01:30"], duration_ms: 60000 };
  assert.equal(nextScheduleWindow(t, t, t + 86400000, gap), null);
  const autumn = ms("2026-10-25T00:00:00Z");
  assert.equal(nextScheduleWindow(autumn, autumn, autumn + 86400000, gap), autumn + 1800000);
  assert.equal(scheduleWindow(autumn + 5400000, autumn, autumn + 86400000, gap), null);
});
