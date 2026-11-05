import { sort } from "remeda";

/**
 * Published-post shape for the What's live calendar, plus the date math the
 * server query and the calendar grid share. Postiz calls a channel an
 * integration; the calendar says channel.
 */

export type PostizUtm = {
  source: string | null;
  medium: string | null;
  campaign: string | null;
};

export type LivePost = {
  id: string;
  content: string;
  publishDate: string;
  channel: {
    provider: string;
    label: string;
    name: string;
  };
  releaseUrl: string | null;
  releaseUtm: PostizUtm | null;
  trackedLinks: Array<{ url: string; utm: PostizUtm }>;
};

/** A Postiz list-posts record after the HTTP boundary has checked its shape. */
export type PostizPostRecord = {
  id: string;
  content: string;
  publishDate: string;
  releaseUrl: string | null;
  state: string;
  settings: unknown;
  provider: string | null;
  channelName: string | null;
};

type CalendarCell = {
  /** Local calendar day, YYYY-MM-DD, in the requested time zone. */
  date: string;
  inMonth: boolean;
};

export type CalendarMonth = {
  month: string;
  timeZone: string;
  label: string;
  cells: CalendarCell[];
  /** Inclusive UTC instants covering every cell, for the Postiz date query. */
  startIso: string;
  endIso: string;
};

const PROVIDER_LABELS: Record<string, string> = {
  facebook: "Facebook",
  "linkedin-page": "LinkedIn Page",
  linkedin: "LinkedIn",
  twitter: "X",
  x: "X",
  instagram: "Instagram",
  "instagram-standalone": "Instagram",
  threads: "Threads",
  youtube: "YouTube",
  tiktok: "TikTok",
  bluesky: "Bluesky",
  mastodon: "Mastodon",
  reddit: "Reddit",
  pinterest: "Pinterest",
  discord: "Discord",
  slack: "Slack",
  telegram: "Telegram",
  gmb: "Google Business Profile",
  wordpress: "WordPress",
};

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/gi;

function channelLabel(provider: string | null | undefined): string {
  const key = (provider ?? "").trim().toLowerCase();
  if (!key) return "Channel";
  return (
    PROVIDER_LABELS[key] ??
    key
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (letter) => letter.toUpperCase())
  );
}

export function toPublishedLivePosts(records: PostizPostRecord[]): LivePost[] {
  return sort(
    records
      .filter((record) => record.state.trim().toUpperCase() === "PUBLISHED")
      .map(toLivePost),
    (a, b) => b.publishDate.localeCompare(a.publishDate),
  );
}

/**
 * Month grid for `YYYY-MM` in `timeZone`. Weeks start on Sunday. Null when
 * the month or time zone cannot be resolved.
 */
export function calendarMonth(
  month: string,
  timeZone: string,
): CalendarMonth | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (!match || !isTimeZone(timeZone)) return null;
  const year = Number(match[1]);
  const monthNumber = Number(match[2]);
  const firstWeekday = weekdayIndex(year, monthNumber, 1, timeZone);
  const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
  const cells: CalendarCell[] = [];
  for (let index = 0; index < cellCount; index += 1) {
    const shifted = addDays(year, monthNumber, 1, index - firstWeekday);
    cells.push({
      date: formatDay(shifted.year, shifted.month, shifted.day),
      inMonth: shifted.month === monthNumber,
    });
  }
  const first = cells[0];
  const last = cells[cells.length - 1];
  if (!first || !last) return null;
  const start = parseDay(first.date);
  const end = parseDay(last.date);
  if (!start || !end) return null;
  const endExclusive = addDays(end.year, end.month, end.day, 1);
  const startInstant = zonedTimeToUtc({
    year: start.year,
    month: start.month,
    day: start.day,
    hour: 0,
    minute: 0,
    timeZone,
  });
  const endInstant = zonedTimeToUtc({
    year: endExclusive.year,
    month: endExclusive.month,
    day: endExclusive.day,
    hour: 0,
    minute: 0,
    timeZone,
  });
  return {
    month,
    timeZone,
    label: new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "long",
      year: "numeric",
    }).format(startInstant),
    cells,
    startIso: startInstant.toISOString(),
    endIso: new Date(endInstant.getTime() - 1).toISOString(),
  };
}

/** Local calendar day of an instant, or null when the timestamp is invalid. */
export function dayKey(iso: string, timeZone: string): string | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime()) || !isTimeZone(timeZone)) return null;
  const parts = zonedParts(instant, timeZone);
  return formatDay(parts.year, parts.month, parts.day);
}

export function currentMonthKey(timeZone: string, now = new Date()): string {
  return dayKey(now.toISOString(), timeZone)?.slice(0, 7) ?? monthKey(now);
}

/** Instant of a wall-clock time in `timeZone`, used to place sample posts. */
export function zonedTimeToUtc(input: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  timeZone: string;
}): Date {
  const guess = Date.UTC(
    input.year,
    input.month - 1,
    input.day,
    input.hour,
    input.minute,
    0,
  );
  let utc = guess - zoneOffsetMs(new Date(guess), input.timeZone);
  utc = guess - zoneOffsetMs(new Date(utc), input.timeZone);
  return new Date(utc);
}

function toLivePost(record: PostizPostRecord): LivePost {
  const provider = record.provider?.trim() || "";
  const label = channelLabel(provider);
  const name = record.channelName?.trim() || label;
  const releaseUrl = httpUrl(record.releaseUrl);
  const trackedLinks = trackedDestinations(record, releaseUrl);
  return {
    id: record.id,
    content: record.content,
    publishDate: record.publishDate,
    channel: { provider, label, name },
    releaseUrl,
    releaseUtm: releaseUrl ? readUtms(releaseUrl) : null,
    trackedLinks,
  };
}

function trackedDestinations(
  record: PostizPostRecord,
  releaseUrl: string | null,
): LivePost["trackedLinks"] {
  const seen = new Set<string>();
  const links: LivePost["trackedLinks"] = [];
  for (const candidate of collectUrls(record.content, record.settings)) {
    if (candidate === releaseUrl || seen.has(candidate)) continue;
    const utm = readUtms(candidate);
    if (!utm) continue;
    seen.add(candidate);
    links.push({ url: candidate, utm });
  }
  return links;
}

function collectUrls(...values: unknown[]): string[] {
  const urls: string[] = [];
  const visit = (value: unknown, depth: number) => {
    if (depth > 4 || value == null) return;
    if (typeof value === "string") {
      for (const match of value.matchAll(URL_PATTERN)) {
        const url = httpUrl(trimTrailingPunctuation(match[0]));
        if (url) urls.push(url);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const item of Object.values(value)) visit(item, depth + 1);
    }
  };
  for (const value of values) visit(value, 0);
  return urls;
}

/** The three Postiz campaign params, when at least one is present. */
function readUtms(rawUrl: string): PostizUtm | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const found: PostizUtm = { source: null, medium: null, campaign: null };
  for (const [key, value] of url.searchParams) {
    const name = key.toLowerCase();
    if (name === "utm_source" && found.source == null) found.source = value;
    if (name === "utm_medium" && found.medium == null) found.medium = value;
    if (name === "utm_campaign" && found.campaign == null)
      found.campaign = value;
  }
  if (!found.source && !found.medium && !found.campaign) return null;
  return found;
}

function httpUrl(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

function trimTrailingPunctuation(value: string): string {
  return value.replace(/[.,;:!?]+$/g, "");
}

function isTimeZone(timeZone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

function weekdayIndex(
  year: number,
  month: number,
  day: number,
  timeZone: string,
): number {
  const noon = zonedTimeToUtc({
    year,
    month,
    day,
    hour: 12,
    minute: 0,
    timeZone,
  });
  const label = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
  }).format(noon);
  const index = WEEKDAYS.findIndex((weekday) => weekday === label);
  return index === -1 ? 0 : index;
}

function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - instant.getTime();
}

function zonedParts(instant: Date, timeZone: string) {
  const map = new Map(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  let year = Number(map.get("year"));
  let month = Number(map.get("month"));
  let day = Number(map.get("day"));
  let hour = Number(map.get("hour"));
  if (hour === 24) {
    hour = 0;
    const next = addDays(year, month, day, 1);
    year = next.year;
    month = next.month;
    day = next.day;
  }
  return {
    year,
    month,
    day,
    hour,
    minute: Number(map.get("minute")),
    second: Number(map.get("second")),
  };
}

function addDays(year: number, month: number, day: number, amount: number) {
  const shifted = new Date(Date.UTC(year, month - 1, day + amount));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function formatDay(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseDay(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function monthKey(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}
