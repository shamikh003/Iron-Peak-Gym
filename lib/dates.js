'use strict';

/* ===================================================================
   IRONPEAK GYM — date helpers

   Every date in this project is a plain calendar date string in
   YYYY-MM-DD form. Two rules keep the maths correct:

   1. "Today" is resolved in the gym's local timezone, not UTC.
      The old code used toISOString(), which in Karachi (UTC+5)
      reported yesterday's date between midnight and 5 AM.

   2. Arithmetic runs on a UTC midnight anchor, so adding days can
      never be skewed by a daylight-saving transition.
   =================================================================== */

const TIMEZONE = process.env.GYM_TIMEZONE || 'Asia/Karachi';

// en-CA formats as YYYY-MM-DD, which is exactly the shape we store.
const localDateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Today's calendar date in the gym's timezone. */
function todayStr(now = new Date()) {
  return localDateFormatter.format(now);
}

/** True when the value is a real calendar date in YYYY-MM-DD form. */
function isValidDateStr(value) {
  if (typeof value !== 'string' || !DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const anchor = new Date(Date.UTC(year, month - 1, day));
  return (
    anchor.getUTCFullYear() === year &&
    anchor.getUTCMonth() === month - 1 &&
    anchor.getUTCDate() === day
  );
}

/** Milliseconds at UTC midnight for a YYYY-MM-DD string. */
function toUtcMillis(dateStr) {
  const [year, month, day] = dateStr.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Format a UTC-midnight timestamp back to YYYY-MM-DD. */
function fromUtcMillis(millis) {
  const date = new Date(millis);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Shift a calendar date by a whole number of days. */
function addDays(dateStr, days) {
  return fromUtcMillis(toUtcMillis(dateStr) + days * DAY_MS);
}

/** Whole days from dateA to dateB. Negative when dateB is earlier. */
function daysBetween(dateA, dateB) {
  return Math.round((toUtcMillis(dateB) - toUtcMillis(dateA)) / DAY_MS);
}

/** Later of two calendar dates. */
function maxDate(a, b) {
  return toUtcMillis(a) >= toUtcMillis(b) ? a : b;
}

module.exports = {
  TIMEZONE,
  todayStr,
  isValidDateStr,
  addDays,
  daysBetween,
  maxDate,
};
