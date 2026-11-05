import { z } from "zod";
import { readBoundedText } from "@/server/lib/scrape";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  calendarMonth,
  toPublishedLivePosts,
  zonedTimeToUtc,
  type CalendarMonth,
  type LivePost,
  type PostizPostRecord,
} from "@/shared/postiz";

const REQUEST_TIMEOUT_MS = 15_000;
const CACHE_MS = 5 * 60 * 1000;
const CACHE_LIMIT = 24;

type WhatsLiveResult = {
  status: "ok" | "unconfigured" | "error";
  source: "live" | "fixture" | "unconfigured" | "error";
  month: string;
  timeZone: string;
  posts: LivePost[];
  message: string | null;
};

const rawPostSchema = z.object({
  id: z.string().min(1),
  content: z.string().nullish(),
  publishDate: z.string().min(1),
  releaseURL: z.string().nullish(),
  releaseUrl: z.string().nullish(),
  state: z.string(),
  settings: z.unknown().optional(),
  integration: z
    .object({
      providerIdentifier: z.string().nullish(),
      name: z.string().nullish(),
    })
    .nullish(),
});

const cache = new Map<string, { at: number; posts: LivePost[] }>();

export const WhatsLiveService = {
  async list(input: {
    month: string;
    timeZone: string;
  }): Promise<WhatsLiveResult> {
    const month = calendarMonth(input.month, input.timeZone);
    if (!month) {
      return {
        status: "error",
        source: "error",
        month: input.month,
        timeZone: input.timeZone,
        posts: [],
        message: "Choose a valid month and time zone.",
      };
    }

    const config = await readConfig();
    if (config.mode === "invalid-url") {
      return result(month, "error", "error", [], postizUrlMessage());
    }
    if (config.mode === "incomplete") {
      return result(
        month,
        "error",
        "error",
        [],
        "Set both POSTIZ_API_URL and POSTIZ_WORK_API_KEY. The key is the existing Postiz work key.",
      );
    }
    if (config.mode === "unconfigured") {
      return result(
        month,
        "unconfigured",
        "unconfigured",
        [],
        "Set POSTIZ_API_URL and POSTIZ_WORK_API_KEY to read published posts.",
      );
    }
    if (config.mode === "fixture") {
      return result(month, "ok", "fixture", fixturePosts(month), null);
    }

    try {
      return result(
        month,
        "ok",
        "live",
        await fetchPublished(config, month),
        null,
      );
    } catch (error) {
      const message =
        error instanceof PostizRequestError
          ? error.message
          : "Postiz could not be reached. Check POSTIZ_API_URL.";
      console.warn(`[whats-live] ${message}`);
      return result(month, "error", "error", [], message);
    }
  },
};

async function readConfig(): Promise<
  | { mode: "live"; apiRoot: string; apiKey: string }
  | { mode: "fixture" }
  | { mode: "unconfigured" }
  | { mode: "incomplete" }
  | { mode: "invalid-url" }
> {
  const apiKey = await getOptionalEnvValue("POSTIZ_WORK_API_KEY");
  const apiUrl = await getOptionalEnvValue("POSTIZ_API_URL");
  const fixtures = await getOptionalEnvValue("POSTIZ_USE_FIXTURES");
  if (apiKey && apiUrl) {
    const apiRoot = postizPublicRoot(apiUrl);
    if (!apiRoot) return { mode: "invalid-url" };
    return { mode: "live", apiRoot, apiKey };
  }
  if (apiKey || apiUrl) return { mode: "incomplete" };
  if (fixturesEnabled(fixtures)) return { mode: "fixture" };
  return { mode: "unconfigured" };
}

async function fetchPublished(
  config: { apiRoot: string; apiKey: string },
  month: CalendarMonth,
): Promise<LivePost[]> {
  const url = new URL(`${config.apiRoot}/posts`);
  url.searchParams.set("startDate", month.startIso);
  url.searchParams.set("endDate", month.endIso);
  const cacheKey = `${config.apiRoot}|${month.startIso}|${month.endIso}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      // Postiz expects the work key itself, not a Bearer token.
      Authorization: config.apiKey,
    },
    redirect: "manual",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (response.status >= 300 && response.status < 400) {
    throw new PostizRequestError(
      "Postiz redirected the request. Check POSTIZ_API_URL.",
    );
  }
  if (response.status === 401 || response.status === 403) {
    throw new PostizRequestError(
      "Postiz rejected POSTIZ_WORK_API_KEY. Use the existing work key.",
    );
  }
  if (response.status === 429) {
    throw new PostizRequestError(
      "Postiz rate limit reached (30 requests an hour). Try again in a little while.",
    );
  }
  if (!response.ok) {
    throw new PostizRequestError(
      "Postiz could not be reached. Check POSTIZ_API_URL.",
    );
  }

  const text = await readBoundedText(response);
  let body: unknown;
  try {
    body = JSON.parse(text ?? "");
  } catch {
    throw new PostizRequestError("Postiz returned an unexpected response.");
  }
  const records = parsePostRecords(body);
  if (!records) {
    throw new PostizRequestError("Postiz returned an unexpected response.");
  }
  const posts = toPublishedLivePosts(records);
  writeCache(cacheKey, posts);
  return posts;
}

/**
 * `POSTIZ_API_URL` is the API root (`https://host/api`). A root that already
 * ends in `/public/v1` is used as-is. The office Postiz root is
 * `https://social.ict365.ky/api`. This URL is operator configuration, including
 * a Postiz on a private host, so it is not sent through the public crawl gateway.
 */
function postizPublicRoot(apiUrl: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(apiUrl.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username || parsed.password) return null;
  const path = parsed.pathname.replace(/\/+$/, "");
  const root = path.endsWith("/public/v1") ? path : `${path}/public/v1`;
  return `${parsed.origin}${root}`;
}

function parsePostRecords(body: unknown): PostizPostRecord[] | null {
  const list = Array.isArray(body)
    ? body
    : isRecord(body) && Array.isArray(body.posts)
      ? body.posts
      : null;
  if (!list) return null;
  const records: PostizPostRecord[] = [];
  for (const item of list) {
    const parsed = rawPostSchema.safeParse(item);
    if (!parsed.success) continue;
    records.push({
      id: parsed.data.id,
      content: parsed.data.content ?? "",
      publishDate: parsed.data.publishDate,
      releaseUrl: parsed.data.releaseURL ?? parsed.data.releaseUrl ?? null,
      state: parsed.data.state,
      settings: parsed.data.settings ?? null,
      provider: parsed.data.integration?.providerIdentifier ?? null,
      channelName: parsed.data.integration?.name ?? null,
    });
  }
  return records;
}

function fixturePosts(month: CalendarMonth): LivePost[] {
  const [year, monthNumber] = month.month.split("-").map(Number);
  const at = (day: number, hour: number) =>
    zonedTimeToUtc({
      year: year ?? 2026,
      month: monthNumber ?? 1,
      day,
      hour,
      minute: 0,
      timeZone: month.timeZone,
    }).toISOString();
  return toPublishedLivePosts([
    {
      id: "fixture-facebook",
      state: "PUBLISHED",
      publishDate: at(3, 10),
      content:
        "Open house this Saturday. Details: https://www.example.com/events/open-house?utm_source=postiz&utm_medium=social&utm_campaign=facebook-open-house",
      releaseUrl: "https://www.facebook.com/example/posts/fixture",
      settings: null,
      provider: "facebook",
      channelName: "Example Page",
    },
    {
      id: "fixture-linkedin",
      state: "PUBLISHED",
      publishDate: at(5, 15),
      content: "A short guide for teams planning their search content.",
      releaseUrl: "https://www.linkedin.com/feed/update/fixture",
      settings: {
        url: "https://www.example.com/guides/search?utm_source=postiz&utm_medium=social&utm_campaign=linkedin-search-guide",
      },
      provider: "linkedin-page",
      channelName: "Example Page",
    },
    {
      id: "fixture-x",
      state: "PUBLISHED",
      publishDate: at(12, 9),
      content: "Shipping a small site fix today.",
      releaseUrl: "https://x.com/example/status/fixture",
      settings: null,
      provider: "twitter",
      channelName: "Example",
    },
    {
      id: "fixture-draft",
      state: "DRAFT",
      publishDate: at(3, 11),
      content: "This draft must not appear on the calendar.",
      releaseUrl: null,
      settings: null,
      provider: "facebook",
      channelName: "Example Page",
    },
  ]);
}

function fixturesEnabled(value: string | undefined): boolean {
  return ["1", "true", "yes"].includes((value ?? "").trim().toLowerCase());
}

function postizUrlMessage(): string {
  return "POSTIZ_API_URL must be an http(s) URL, for example https://social.ict365.ky/api.";
}

function result(
  month: CalendarMonth,
  status: WhatsLiveResult["status"],
  source: WhatsLiveResult["source"],
  posts: LivePost[],
  message: string | null,
): WhatsLiveResult {
  return {
    status,
    source,
    month: month.month,
    timeZone: month.timeZone,
    posts,
    message,
  };
}

function readCache(key: string): LivePost[] | null {
  // Vitest reuses this module, so a cached month would leak between tests.
  if (process.env.VITEST) return null;
  const hit = cache.get(key);
  if (!hit || Date.now() - hit.at > CACHE_MS) return null;
  return hit.posts;
}

function writeCache(key: string, posts: LivePost[]) {
  if (process.env.VITEST) return;
  cache.set(key, { at: Date.now(), posts });
  if (cache.size <= CACHE_LIMIT) return;
  const oldest = cache.keys().next().value;
  if (oldest) cache.delete(oldest);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class PostizRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PostizRequestError";
  }
}
