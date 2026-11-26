"use strict";

// Durations and wall-clock dates as text. Pure; the caller passes the localised unit words.
// Wall ms (see model.ts) are formatted with timeZone "UTC" so the viewer's zone never shifts
// a printed date.

export type DurationUnit = "auto" | "minutes" | "hours" | "days" | "weeks";

export interface UnitWords { min: string; h: string; d: string; wk: string; lessThanMin: string }

import { formatModelNumber } from "./shared/numberFormat";

const MIN = 60000, HOUR = 3600000, DAY = 86400000, WEEK = 7 * DAY;

/** The unit Auto picks for a duration: under 1 h minutes, under 2 days hours, under 14 days
 *  days, otherwise weeks. A column uses the unit of its LARGEST value so it reads in one unit. */
export function autoUnit(ms: number): Exclude<DurationUnit, "auto"> {
    if (ms < HOUR) return "minutes";
    if (ms < 2 * DAY) return "hours";
    if (ms < 14 * DAY) return "days";
    return "weeks";
}

function num(v: number, locale: string): string {
    const digits = v !== 0 && Math.abs(v) < 10 && Math.round(v) !== v ? 1 : 0;
    // fix round 11 (S1): every number the visual prints goes through the shared formatter; a
    // duration has no model format, so its precision is the format "0" or "0.0" (no separator)
    return formatModelNumber(v, digits ? "0.0" : "0", locale);
}

/** ms as "3 wk", "4.5 d", "12 h", "35 min". Values under 10 keep one decimal, larger ones are
 *  whole. A positive duration that would print as 0 prints "<1 min" (or "<0.1 h" and so on). */
export function formatDuration(ms: number, unit: DurationUnit, words: UnitWords, locale: string): string {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const u = unit === "auto" ? autoUnit(ms) : unit;
    const [size, word] = u === "minutes" ? [MIN, words.min] : u === "hours" ? [HOUR, words.h] : u === "days" ? [DAY, words.d] : [WEEK, words.wk];
    const v = ms / size;
    if (u === "minutes" && ms > 0 && ms < MIN) return words.lessThanMin;
    const rounded = Math.abs(v) < 10 ? Math.round(v * 10) / 10 : Math.round(v);
    if (ms > 0 && rounded === 0) return `<${num(0.1, locale)} ${word}`;
    return `${num(rounded, locale)} ${word}`;
}

const UNIT_MS: Record<Exclude<DurationUnit, "auto">, number> = { minutes: MIN, hours: HOUR, days: DAY, weeks: WEEK };

/** Decimals for a totals table in ONE unit (fix round 1, M4): 0, unless two different totals
 *  would print alike in whole units (80.49 d and 76.6 d are both "11" weeks), or a positive
 *  total would print as "<1" - then 1 for the whole table, so the columns keep one format. */
export function tableDecimals(values: number[], unit: Exclude<DurationUnit, "auto">): 0 | 1 {
    const seen = new Map<number, number>();
    for (const v of values) {
        if (!Number.isFinite(v)) continue;
        const k = Math.round(v / UNIT_MS[unit]);
        if (v > 0 && k === 0) return 1;     // a positive total would print as "<1"
        const prev = seen.get(k);
        if (prev !== undefined && prev !== v) return 1;
        seen.set(k, v);
    }
    return 0;
}

/** A table total as a bare number in the table's unit with `dec` decimals. 0 prints "0"; a
 *  positive total too small to show prints "<0.1" (or "<1"), never "0". */
export function formatTableValue(ms: number, unit: Exclude<DurationUnit, "auto">, dec: 0 | 1, locale: string): string {
    if (!Number.isFinite(ms) || ms < 0) return "";
    const v = ms / UNIT_MS[unit];
    const step = dec === 1 ? 0.1 : 1;
    const f = dec === 1 ? "0.0" : "0";   // fix round 11 (S1): the shared formatter, no separator
    if (ms > 0 && Math.round(v / step) === 0) return "<" + formatModelNumber(step, f, locale);
    // rounded half up first, as formatDuration rounds (the shared formatter rounds a half on the
    // double's exact value: 0.15 min would print 0.1 in the table and 0.2 in the tooltip)
    return formatModelNumber(dec === 1 ? Math.round(v * 10) / 10 : Math.round(v), f, locale);
}

// fix round 11 (S2): a formatter is built once per locale and option set, not on every call (the
// Board profile: building them was 6 ms of a 26 ms update, most of it the strip labels' since text)
const FMT_CACHE = new Map<string, Intl.DateTimeFormat>();
function fmt(locale: string, o: Intl.DateTimeFormatOptions) {
    const key = locale + "|" + JSON.stringify(o);
    const hit = FMT_CACHE.get(key);
    if (hit) return hit;
    let f: Intl.DateTimeFormat;
    try { f = new Intl.DateTimeFormat(locale, Object.assign({ timeZone: "UTC" }, o)); }
    catch { f = new Intl.DateTimeFormat("en-US", Object.assign({ timeZone: "UTC" }, o)); }
    if (FMT_CACHE.size >= 256) FMT_CACHE.clear();
    FMT_CACHE.set(key, f);
    return f;
}

/** The clock fields a time needs (review 4, finding 4): 0 hh:mm, 1 hh:mm:ss, 2 hh:mm:ss.mmm. */
export function timePrecision(t: number): 0 | 1 | 2 {
    const d = new Date(t);
    return d.getUTCMilliseconds() !== 0 ? 2 : d.getUTCSeconds() !== 0 ? 1 : 0;
}

function clockOptions(precision: number): Intl.DateTimeFormatOptions {
    const o: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
    if (precision >= 1) o.second = "2-digit";
    if (precision >= 2) (o as Intl.DateTimeFormatOptions & { fractionalSecondDigits: number }).fractionalSecondDigits = 3;
    return o;
}

/** Date, plus the time when the value is not midnight: to the minute, or to the second / the
 *  millisecond when the value has them (review 4, finding 4), so two different instants never
 *  print alike. */
export function formatWhen(t: number, locale: string): string {
    const d = new Date(t);
    const midnight = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
    return midnight ? fmt(locale, { day: "numeric", month: "short", year: "numeric" }).format(d)
        : fmt(locale, Object.assign({ day: "numeric", month: "short", year: "numeric" }, clockOptions(timePrecision(t)))).format(d);
}

/** Date only, with the year ("5 Jan 2026"). */
export function formatDay(t: number, locale: string): string {
    return fmt(locale, { day: "numeric", month: "short", year: "numeric" }).format(new Date(t));
}

export function formatShortDate(t: number, locale: string): string {
    return fmt(locale, { day: "numeric", month: "short" }).format(new Date(t));
}

export function formatMonth(t: number, locale: string): string {
    return fmt(locale, { month: "short" }).format(new Date(t));
}

/** A calendar bucket's own label for the block strips' categorical period axis (review 2,
 *  finding 1): the bucket's first day ("Jan 5"), its month ("Feb"), quarter ("Q2") or year;
 *  `withYear` adds the year ("Jan 5, 2026", "Feb 2026", "Q2 2026"). */
export function formatPeriod(b0: number, grain: "hour" | "day" | "week" | "month" | "quarter" | "year", withYear: boolean, locale: string): string {
    const d = new Date(b0);
    // Desktop fix round 1, finding 2: an hour block is named by its clock time, and the block that
    // starts a day by its date ("Nov 20"); with the year, the date and year lead ("Nov 20, 2026, 2:00 PM")
    if (grain === "hour") {
        if (isMidnight(b0)) return withYear ? formatDay(b0, locale) : formatShortDate(b0, locale);
        return withYear ? fmt(locale, Object.assign({ day: "numeric", month: "short", year: "numeric" }, clockOptions(0))).format(d) : fmt(locale, clockOptions(0)).format(d);
    }
    if (grain === "year") return fmt(locale, { year: "numeric" }).format(d);
    if (grain === "quarter") return `Q${Math.floor(d.getUTCMonth() / 3) + 1}` + (withYear ? ` ${fmt(locale, { year: "numeric" }).format(d)}` : "");
    if (grain === "month") return withYear ? fmt(locale, { month: "short", year: "numeric" }).format(d) : formatMonth(b0, locale);
    return withYear ? formatDay(b0, locale) : formatShortDate(b0, locale);
}

/** True when [start, end] runs over a calendar day boundary (wall ms). */
export function crossesDay(start: number, end: number): boolean {
    return Math.floor(start / DAY) !== Math.floor(end / DAY);
}

function isMidnight(t: number): boolean { return ((t % DAY) + DAY) % DAY === 0; }

/** An elapsed-time axis label. `extra` raises the precision (review 4, finding 4): on a time axis
 *  (span up to 2 days) 0 is hh:mm, 1 adds seconds, 2 milliseconds, and 3-5 put the date in front
 *  of those (review 5, finding 4: the same clock time on two days never shares a label); on a date
 *  axis 1-4 add the time (hh:mm, then seconds, then milliseconds) after the day. `crossesDay`: a
 *  time axis that runs over a day boundary names each midnight by its date ("Apr 2"). */
export function formatAxis(t: number, span: number, locale: string, extra = 0, dayCross = false): string {
    const d = new Date(t);
    if (span <= 2 * DAY) {
        if (extra >= 3) return fmt(locale, Object.assign({ day: "numeric", month: "short" }, clockOptions(extra - 3))).format(d);
        if (dayCross && isMidnight(t)) return formatShortDate(t, locale);
        return fmt(locale, clockOptions(extra)).format(d);
    }
    if (extra > 0) return fmt(locale, Object.assign({ day: "numeric", month: "short" }, clockOptions(extra - 1))).format(d);
    if (span > 3 * 365 * DAY) return fmt(locale, { year: "numeric" }).format(d);
    if (span > 60 * DAY) return d.getUTCMonth() === 0 ? fmt(locale, { month: "short", year: "numeric" }).format(d) : formatMonth(t, locale);
    return formatShortDate(t, locale);
}

/** True when formatAxis prints a date for this label (always on a date axis). */
export function axisLabelHasDate(t: number, span: number, extra: number, dayCross: boolean): boolean {
    return span > 2 * DAY || extra >= 3 || (dayCross && isMidnight(t));
}

/** The Runs axis END label (fix round 4, item 7): the As of instant itself, never a period name
 *  (a month-tier axis names ticks "Jun", but its end is "Jun 14"; a multi-year axis ends "Jun 2029"). */
export function formatAxisEnd(t: number, span: number, locale: string, extra = 0, dayCross = false): string {
    if (span <= 2 * DAY || extra > 0) return formatAxis(t, span, locale, extra, dayCross);
    if (span > 3 * 365 * DAY) return fmt(locale, { month: "short", year: "numeric" }).format(new Date(t));
    return formatShortDate(t, locale);   // the As of day itself
}

/** Shared-code round (Part A): true when formatAxis (or, `end`, formatAxisEnd) already prints the
 *  label's year ("2026", "Jan 2026", "Sep 2026"). Clock and day + clock labels never do. */
export function axisLabelHasYear(t: number, span: number, extra: number, end = false): boolean {
    if (span <= 2 * DAY || extra > 0) return false;
    if (span > 3 * 365 * DAY) return true;
    if (end) return false;
    return span > 60 * DAY && new Date(t).getUTCMonth() === 0;
}

/** Shared-code round (Part A): the same axis label at the same precision with its year added
 *  ("Sep 30, 2025, 8:00 AM", "Sep 2025", "Dec 31, 2025"). A clock-only label names no date and
 *  stays as it is. `end`: the formatAxisEnd label. */
export function formatAxisWithYear(t: number, span: number, locale: string, extra = 0, dayCross = false, end = false): string {
    const d = new Date(t);
    const dmy: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };
    if (span <= 2 * DAY) {
        if (extra >= 3) return fmt(locale, Object.assign(dmy, clockOptions(extra - 3))).format(d);
        if (dayCross && isMidnight(t)) return formatDay(t, locale);
        return fmt(locale, clockOptions(extra)).format(d);
    }
    if (extra > 0) return fmt(locale, Object.assign(dmy, clockOptions(extra - 1))).format(d);
    if (end) return span > 3 * 365 * DAY ? formatAxisEnd(t, span, locale, extra, dayCross) : formatDay(t, locale);
    if (span > 3 * 365 * DAY) return fmt(locale, { year: "numeric" }).format(d);
    if (span > 60 * DAY) return fmt(locale, { month: "short", year: "numeric" }).format(d);
    return formatDay(t, locale);
}

/** The highest `extra` formatAxis takes for a span. */
export function axisMaxExtra(span: number): number { return span <= 2 * DAY ? 5 : 3; }

/** Axis tick positions (wall ms) at calendar boundaries: years, months, weeks, days or hours,
 *  the finest that leaves at most `maxTicks`. */
export function axisTicks(start: number, end: number, maxTicks: number): number[] {
    const span = end - start;
    const cands: Array<(t: number) => number> = [];
    const every = (size: number) => (t: number) => Math.floor(t / size) * size + size;
    const hour = (step: number) => every(step * HOUR);
    const day = (step: number) => (t: number) => Math.floor(t / (step * DAY)) * step * DAY + step * DAY;
    const month = (step: number) => (t: number) => { const d = new Date(t); const m = d.getUTCMonth(); const nm = m - (m % step) + step; return Date.UTC(d.getUTCFullYear(), nm, 1); };
    const year = (step: number) => (t: number) => { const y = new Date(t).getUTCFullYear(); return Date.UTC(y - (y % step) + step, 0, 1); };
    // review 4 finding 4: sub-hour spans get millisecond, second and minute ticks
    if (span <= 10 * 1000) [1, 2, 5, 10, 20, 50, 100, 200, 500].forEach(s => cands.push(every(s)));
    if (span <= 10 * MIN) [1, 2, 5, 10, 15, 30].forEach(s => cands.push(every(s * 1000)));
    if (span <= 6 * HOUR) [1, 2, 5, 10, 15, 30].forEach(s => cands.push(every(s * MIN)));
    if (span <= 3 * DAY) [1, 3, 6, 12].forEach(s => cands.push(hour(s)));
    if (span <= 120 * DAY) [1, 2, 7, 14].forEach(s => cands.push(day(s)));
    [1, 2, 3, 6].forEach(s => cands.push(month(s)));
    [1, 2, 5, 10, 25, 50, 100].forEach(s => cands.push(year(s)));
    for (const next of cands) {
        const out: number[] = [];
        for (let t = next(start - 1); t <= end && out.length <= maxTicks; t = next(t)) out.push(t);
        if (out.length <= maxTicks) return out;
    }
    return [];
}
