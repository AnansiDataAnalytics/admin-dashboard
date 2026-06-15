// Weekly build cadence: every Wednesday at 02:00 local time. Pure helpers — inject
// `now` so they're deterministic and unit-testable (no reliance on the wall clock).
const RUN_DOW = 3;     // Wednesday (0 = Sunday)
const RUN_HOUR = 2;
const GRACE_HOURS = 6; // how long after a scheduled run before it's "overdue"
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A Date at RUN_HOUR:00 on the same calendar day as `nowMs`.
function startOfScheduleDay(nowMs) {
  const d = new Date(nowMs);
  d.setHours(RUN_HOUR, 0, 0, 0);
  return d;
}

// The most recent scheduled run time at or before `nowMs`.
export function mostRecentScheduledMs(nowMs) {
  const d = startOfScheduleDay(nowMs);
  let back = (d.getDay() - RUN_DOW + 7) % 7;
  if (back === 0 && nowMs < d.getTime()) back = 7; // Wed but before 02:00 → last week
  d.setDate(d.getDate() - back);
  return d.getTime();
}

// The next scheduled run time at or after `nowMs`.
export function nextScheduledMs(nowMs) {
  const d = startOfScheduleDay(nowMs);
  let add = (RUN_DOW - d.getDay() + 7) % 7;
  if (add === 0 && nowMs >= d.getTime()) add = 7; // past 02:00 today → next week
  d.setDate(d.getDate() + add);
  return d.getTime();
}

// Display label for the next scheduled run — concrete date, no weekday (the
// cadence already lives in the page topbar). Takes epoch ms, like its siblings.
export function nextScheduledRunLabel(nowMs = Date.now()) {
  const d = new Date(nextScheduledMs(nowMs));
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()} · 02:00`;
}

// Is a scheduled run overdue? Overdue when the most-recent scheduled time has
// passed by more than `graceHours` and no run has reported at/after it.
export function runStaleness({ lastRunMs, nowMs, graceHours = GRACE_HOURS }) {
  const scheduledMs = mostRecentScheduledMs(nowMs);
  const ranForLatest = lastRunMs != null && lastRunMs >= scheduledMs;
  const overdue = nowMs >= scheduledMs + graceHours * 3600 * 1000 && !ranForLatest;
  return { overdue, scheduledMs, lastRunMs: lastRunMs ?? null, ranForLatest };
}
