/**
 * The clock a workflow keeps: cron expressions for the Schedule trigger, and
 * the window a "Wait for business hours" step holds for.
 *
 * Both are read in a named time zone, because "9am on weekdays" is a fact
 * about a place. `Intl` does the zone arithmetic, including daylight saving;
 * nothing here knows an offset.
 */

interface ZonedMinute {
  minute: number;
  hour: number;
  day: number;
  month: number;
  /** 0 is Sunday. */
  weekday: number;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTH_NAMES = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The formatter for a zone. Throws a RangeError for a zone that is not one. */
function formatterFor(zone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(zone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
    formatters.set(zone, formatter);
  }
  return formatter;
}

function zoned(date: Date, zone: string): ZonedMinute {
  const parts: Record<string, string> = {};
  for (const part of formatterFor(zone).formatToParts(date)) parts[part.type] = part.value;
  return {
    minute: Number(parts['minute']),
    hour: Number(parts['hour']) % 24,
    day: Number(parts['day']),
    month: Number(parts['month']),
    weekday: WEEKDAYS.indexOf(String(parts['weekday']).slice(0, 3).toLowerCase()),
  };
}

/** Whether `zone` is a time zone this runtime knows. */
export function isTimeZone(zone: string): boolean {
  try {
    formatterFor(zone);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Cron                                                                */
/* ------------------------------------------------------------------ */

export interface CronSchedule {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether the day-of-month and day-of-week fields were given as something other than `*`. */
  dayRestricted: boolean;
  weekdayRestricted: boolean;
}

export type CronResult = { ok: true; schedule: CronSchedule } | { ok: false; error: string };

function field(source: string, min: number, max: number, names: readonly string[] | null, what: string): Set<number> {
  const values = new Set<number>();
  const number = (raw: string): number => {
    // `mon` or `monday`, and nothing that merely starts like one.
    const lower = raw.toLowerCase();
    const named = names === null ? -1 : names.findIndex((name, index) => lower === name || lower === (names === MONTHS ? MONTH_NAMES : WEEKDAY_NAMES)[index]);
    // Digits and nothing else: `Number` would also take `0x10`, `1e1` and an empty string.
    if (named < 0 && !/^\d{1,4}$/.test(raw)) throw new Error(`“${raw}” is not a ${what}`);
    return named >= 0 ? named + (names === MONTHS ? 1 : 0) : Number(raw);
  };
  for (const part of source.split(',')) {
    const pieces = part.split('/');
    if (pieces.length > 2) throw new Error(`“${part}” has more than one step`);
    const [range = '', stepText] = pieces;
    if (stepText !== undefined && !/^\d{1,4}$/.test(stepText)) throw new Error(`“${part}” has a step that is not a whole number above zero`);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new Error(`“${part}” has a step that is not a whole number above zero`);
    let from: number;
    let to: number;
    if (range === '*') [from, to] = [min, max];
    else if (range.includes('-')) {
      const ends = range.split('-');
      if (ends.length !== 2) throw new Error(`“${part}” is not a range: write it as 1-5`);
      [from, to] = [number(ends[0]!), number(ends[1]!)];
      // `sat-sun`: Sunday is both ends of the week, and a range that finishes on it means the 7.
      if (names === WEEKDAYS && to === 0 && from > 0) to = 7;
    } else {
      from = number(range);
      // `5/15` means "from 5, every 15", as it does in cron.
      to = stepText === undefined ? from : max;
    }
    if (from < min || to > max || from > to) throw new Error(`“${part}” is outside ${min}–${max} for the ${what}`);
    for (let value = from; value <= to; value += step) values.add(value);
  }
  return values;
}

/** Reads a five-field cron expression: minute, hour, day of month, month, day of week. */
export function parseCron(expression: string): CronResult {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return { ok: false, error: `A cron expression has five fields (minute hour day month weekday); “${expression.trim()}” has ${fields.length}.` };
  try {
    const weekdays = field(fields[4]!, 0, 7, WEEKDAYS, 'day of the week');
    // Both 0 and 7 are Sunday.
    if (weekdays.has(7)) {
      weekdays.delete(7);
      weekdays.add(0);
    }
    return {
      ok: true,
      schedule: {
        minutes: field(fields[0]!, 0, 59, null, 'minute'),
        hours: field(fields[1]!, 0, 23, null, 'hour'),
        days: field(fields[2]!, 1, 31, null, 'day of the month'),
        months: field(fields[3]!, 1, 12, MONTHS, 'month'),
        weekdays,
        // Cron's rule goes by how the field opens: `*/2` is every other day, and still "any day" where the weekday is concerned.
        dayRestricted: !fields[2]!.startsWith('*'),
        weekdayRestricted: !fields[4]!.startsWith('*'),
      },
    };
  } catch (error) {
    return { ok: false, error: `The cron expression “${expression.trim()}” cannot be read: ${error instanceof Error ? error.message : String(error)}.` };
  }
}

function dayMatches(schedule: CronSchedule, at: ZonedMinute): boolean {
  if (!schedule.months.has(at.month)) return false;
  const day = schedule.days.has(at.day);
  const weekday = schedule.weekdays.has(at.weekday);
  // Cron's own rule: when both day fields are restricted, either one matching is enough.
  return schedule.dayRestricted && schedule.weekdayRestricted ? day || weekday : day && weekday;
}

/** How far ahead a schedule is searched for its next minute: far enough for 29 February. */
const SEARCH_MS = 5 * 366 * 24 * 3_600_000;

/**
 * The first minute strictly after `after` that the schedule names, in `zone`. Null when it names none.
 *
 * Twice a year the clock in most zones is moved, and a schedule that names an
 * hour meets a day that has it twice or not at all. It does what cron does:
 * an hour that comes round twice fires the first time only, and an hour the
 * clock jumps over fires once, as the jump lands. A schedule for every hour
 * is not about an hour, and runs through both untouched.
 */
export function nextCronTime(schedule: CronSchedule, after: Date, zone: string): Date | null {
  let candidate = Math.floor(after.getTime() / 60_000) * 60_000 + 60_000;
  const limit = candidate + SEARCH_MS;
  const namesHours = schedule.hours.size < 24;
  while (candidate < limit) {
    const at = zoned(new Date(candidate), zone);
    if (namesHours && at.minute === 0 && dayMatches(schedule, at)) {
      // The clock went forward over an hour the schedule names: it is owed, and paid here.
      const before = zoned(new Date(candidate - 60_000), zone);
      const jumped = (at.hour - before.hour + 24) % 24 === 2 ? (before.hour + 1) % 24 : -1;
      if (jumped >= 0 && schedule.hours.has(jumped)) return new Date(candidate);
    }
    if (dayMatches(schedule, at) && schedule.hours.has(at.hour)) {
      if (namesHours) {
        // The clock went back and this hour is here for the second time: it has already fired.
        const hourAgo = zoned(new Date(candidate - 3_600_000), zone);
        if (hourAgo.hour === at.hour && hourAgo.day === at.day) {
          candidate += (60 - at.minute) * 60_000;
          continue;
        }
      }
      if (schedule.minutes.has(at.minute)) return new Date(candidate);
      // The next minute this hour names, or on to the next hour.
      let next = at.minute + 1;
      while (next < 60 && !schedule.minutes.has(next)) next += 1;
      candidate += (next - at.minute) * 60_000;
      continue;
    }
    // Hour by hour rather than day by day: a day is 23 or 25 hours twice a year, and an hour is always found again.
    candidate += (60 - at.minute) * 60_000;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Business hours                                                      */
/* ------------------------------------------------------------------ */

export type WindowResult = { ok: true; waitMs: number; opensAt: Date } | { ok: false; error: string };

interface HoursWindow {
  from: number;
  to: number;
  weekdays: Set<number>;
}

/** `09:00-18:00 Mon-Fri`: a time range, then the days it applies to. No days means every day. */
function parseWindow(source: string): HoursWindow | string {
  const match = /^\s*(\d{1,2}):(\d{2})\s*[-–]\s*(\d{1,2}):(\d{2})\s*(.*)$/.exec(source);
  if (match === null) return `“${source}” is not a window. Write it as 09:00-18:00 Mon-Fri.`;
  const from = Number(match[1]) * 60 + Number(match[2]);
  const to = Number(match[3]) * 60 + Number(match[4]);
  if (from >= 24 * 60 || to > 24 * 60 || from === to) return `“${source}” has hours that are not a time of day.`;
  const days = match[5]!.trim();
  if (days.length === 0) return { from, to, weekdays: new Set([0, 1, 2, 3, 4, 5, 6]) };
  const weekdays = new Set<number>();
  for (const part of days.split(/[,\s]+/).filter(Boolean)) {
    const [low = '', high] = part.split(/[-–]/);
    const start = WEEKDAYS.indexOf(low.slice(0, 3).toLowerCase());
    const end = high === undefined ? start : WEEKDAYS.indexOf(high.slice(0, 3).toLowerCase());
    if (start < 0 || end < 0) return `“${part}” is not a day or a range of days. Write Mon-Fri, or Mon, Wed, Fri.`;
    // Fri-Mon wraps round the weekend.
    for (let day = start; ; day = (day + 1) % 7) {
      weekdays.add(day);
      if (day === end) break;
    }
  }
  return { from, to, weekdays };
}

function inside(window: HoursWindow, at: ZonedMinute): boolean {
  const minute = at.hour * 60 + at.minute;
  if (window.from < window.to) return window.weekdays.has(at.weekday) && minute >= window.from && minute < window.to;
  // A window that crosses midnight belongs to the day it opens on.
  if (minute >= window.from) return window.weekdays.has(at.weekday);
  return minute < window.to && window.weekdays.has((at.weekday + 6) % 7);
}

/** How long until `window` is open in `zone`: zero when it already is. */
export function nextWindowOpening(now: Date, window: string, zone: string): WindowResult {
  const parsed = parseWindow(window);
  if (typeof parsed === 'string') return { ok: false, error: parsed };
  if (!isTimeZone(zone)) return { ok: false, error: `“${zone}” is not a time zone. Use a name like Europe/London.` };
  if (inside(parsed, zoned(now, zone))) return { ok: true, waitMs: 0, opensAt: now };
  const start = Math.floor(now.getTime() / 60_000) * 60_000 + 60_000;
  for (let step = 0; step < 8 * 24 * 60; step += 1) {
    const candidate = new Date(start + step * 60_000);
    if (inside(parsed, zoned(candidate, zone))) return { ok: true, waitMs: candidate.getTime() - now.getTime(), opensAt: candidate };
  }
  return { ok: false, error: `“${window}” never opens.` };
}
