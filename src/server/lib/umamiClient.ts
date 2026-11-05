import { sort } from "remeda";
import { z } from "zod";
import { normalizeAndValidateStartUrl } from "@/server/lib/audit/url-policy";
import { AppError } from "@/server/lib/errors";
import { readBoundedText } from "@/server/lib/scrape";
import { UmamiError } from "@/server/lib/umamiErrors";
import {
  umamiApiRoot,
  type UmamiAuthType,
  type UmamiHeader,
} from "@/shared/umami";

const REQUEST_TIMEOUT_MS = 15_000;
const WEBSITE_PAGE_SIZE = 100;
const MAX_WEBSITE_PAGES = 20;

/** Decrypted credentials for one Umami server. Lives in memory only. */
type UmamiCredentials = {
  baseUrl: string;
  authType: UmamiAuthType;
  username: string | null;
  secret: string;
  headers: UmamiHeader[];
};

/** Inclusive epoch-millisecond window, the way Umami takes date ranges. */
export type UmamiTimeRange = { startAt: number; endAt: number };

type UmamiExpandedMetricType = "entry" | "path" | "referrer" | "channel";

const loginSchema = z.union([
  z.object({ token: z.string().min(1) }),
  z.object({ requiresTwoFactor: z.literal(true) }),
]);

const websiteSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  domain: z.string().nullish(),
});
export type UmamiWebsite = z.infer<typeof websiteSchema>;

const websiteListSchema = z.object({
  data: z.array(websiteSchema),
  count: z.number().optional(),
});

const count = z.coerce.number().catch(0);

const statsSchema = z.object({
  pageviews: count,
  visitors: count,
  visits: count,
  bounces: count,
  totaltime: count,
});
export type UmamiStats = z.infer<typeof statsSchema>;

const seriesSchema = z.array(z.object({ x: z.string(), y: count }));
const pageviewSeriesSchema = z.object({
  pageviews: seriesSchema,
  sessions: seriesSchema,
});

const expandedMetricsSchema = z.array(
  z.object({
    name: z.string(),
    pageviews: count,
    visitors: count,
    visits: count,
    bounces: count,
    totaltime: count,
  }),
);
type UmamiExpandedMetric = z.infer<typeof expandedMetricsSchema>[number];

// Umami 3.0.3 filters a referrer with contains (`c.`), not regex (`re.`,
// added in 3.1). A `re.` value is the organic marker: one contains query per
// search engine, summed. `google.` also matches news.google.com. Totals still
// come from the organicSearch channel.
const ORGANIC_REFERRER_CONTAINS = [
  "google.",
  "bing.com",
  "duckduckgo.com",
  "ecosia.org",
  "yandex.",
  "baidu.com",
  "yahoo.com",
  "qwant.com",
  "startpage.com",
  "brave.com",
  "naver.com",
  "seznam.cz",
  "msn.com",
  "ya.ru",
] as const;

const isOrganicReferrerFilter = (referrer?: string) =>
  referrer?.startsWith("re.") === true;

type UmamiSeries = z.infer<typeof pageviewSeriesSchema>;

function mergePoints(
  series: UmamiSeries["pageviews"][],
): UmamiSeries["pageviews"] {
  const totals = new Map<string, number>();
  for (const points of series) {
    for (const point of points) {
      totals.set(point.x, (totals.get(point.x) ?? 0) + point.y);
    }
  }
  return sort([...totals.entries()], ([left], [right]) =>
    left.localeCompare(right),
  ).map(([x, y]) => ({ x, y }));
}

function mergeMetrics(parts: UmamiExpandedMetric[][]): UmamiExpandedMetric[] {
  const totals = new Map<string, UmamiExpandedMetric>();
  for (const rows of parts) {
    for (const row of rows) {
      const current = totals.get(row.name);
      if (!current) {
        totals.set(row.name, { ...row });
        continue;
      }
      current.pageviews += row.pageviews;
      current.visitors += row.visitors;
      current.visits += row.visits;
      current.bounces += row.bounces;
      current.totaltime += row.totaltime;
    }
  }
  return sort(
    [...totals.values()],
    (left, right) =>
      right.visits - left.visits || left.name.localeCompare(right.name),
  );
}

function statusError(status: number): UmamiError {
  if (status === 401 || status === 403) {
    return new UmamiError(
      "umami_auth_failed",
      "Umami rejected the saved credentials.",
      status,
    );
  }
  if (status === 404) {
    return new UmamiError(
      "umami_website_inaccessible",
      "Umami could not find this website or API route.",
      status,
    );
  }
  if (status === 429) {
    return new UmamiError(
      "umami_rate_limited",
      "Umami rate limit reached.",
      status,
    );
  }
  return new UmamiError(
    "umami_unreachable",
    `Umami answered with HTTP ${status}.`,
    status,
  );
}

function query(
  range: UmamiTimeRange,
  extra: Record<string, string | number | undefined> = {},
): string {
  const params = new URLSearchParams({
    startAt: String(range.startAt),
    endAt: String(range.endAt),
  });
  for (const [key, value] of Object.entries(extra)) {
    if (value !== undefined) params.set(key, String(value));
  }
  return params.toString();
}

const websitePath = (websiteId: string) =>
  `/websites/${encodeURIComponent(websiteId)}`;

/**
 * A client for one Umami server. Password logins happen once per client and
 * the token is kept only for the client's lifetime. The base URL is checked
 * against the outbound URL policy before the first request, and redirects are
 * never followed: a redirect target would skip that check.
 */
export function createUmamiClient(credentials: UmamiCredentials) {
  let apiRootPromise: Promise<string> | null = null;
  let authPromise: Promise<Record<string, string>> | null = null;

  async function resolveApiRoot(): Promise<string> {
    try {
      const validated = await normalizeAndValidateStartUrl(credentials.baseUrl);
      return umamiApiRoot(validated.replace(/\/+$/, ""));
    } catch (error) {
      if (error instanceof AppError) {
        throw new UmamiError(
          "umami_url_blocked",
          "This Umami URL points at a private or reserved address.",
        );
      }
      throw error;
    }
  }

  async function send(
    path: string,
    init: { method?: "GET" | "POST"; body?: unknown; auth: boolean },
  ): Promise<unknown> {
    apiRootPromise ??= resolveApiRoot();
    const apiRoot = await apiRootPromise;
    const headers: Record<string, string> = {};
    for (const header of credentials.headers) {
      headers[header.name] = header.value;
    }
    headers.accept = "application/json";
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.auth) Object.assign(headers, await authHeaders());

    let response: Response;
    try {
      response = await fetch(`${apiRoot}${path}`, {
        method: init.method ?? "GET",
        headers,
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new UmamiError(
        "umami_unreachable",
        "Could not reach the Umami server.",
      );
    }
    if (response.status >= 300 && response.status < 400) {
      throw new UmamiError(
        "umami_unreachable",
        "The Umami URL redirects elsewhere. Enter the final URL, including https://.",
        response.status,
      );
    }
    if (!response.ok) throw statusError(response.status);

    const text = await readBoundedText(response);
    if (text === null) {
      throw new UmamiError(
        "umami_malformed_response",
        "Umami returned an unreadable response.",
      );
    }
    try {
      return JSON.parse(text);
    } catch {
      // An auth proxy's HTML login page lands here with a 200.
      throw new UmamiError(
        "umami_malformed_response",
        "The Umami URL did not return JSON. Check the URL and any auth proxy headers.",
      );
    }
  }

  function parse<T>(schema: z.ZodType<T>, value: unknown): T {
    const result = schema.safeParse(value);
    if (!result.success) {
      throw new UmamiError(
        "umami_malformed_response",
        "Umami returned an unexpected response.",
      );
    }
    return result.data;
  }

  async function login(): Promise<Record<string, string>> {
    let body: unknown;
    try {
      body = await send("/auth/login", {
        method: "POST",
        body: {
          username: credentials.username ?? "",
          password: credentials.secret,
        },
        auth: false,
      });
    } catch (error) {
      // Umami answers a wrong username or password with 401.
      if (error instanceof UmamiError && error.status === 401) {
        throw new UmamiError(
          "umami_auth_failed",
          "Umami rejected the username or password.",
          401,
        );
      }
      throw error;
    }
    const result = parse(loginSchema, body);
    if ("requiresTwoFactor" in result) {
      throw new UmamiError(
        "umami_two_factor_required",
        "This Umami user has two-factor authentication on. Use a user without it, for example a view-only user.",
      );
    }
    return { authorization: `Bearer ${result.token}` };
  }

  function authHeaders(): Promise<Record<string, string>> {
    if (credentials.authType === "api_key") {
      // Self-hosted API keys (Umami 3.4+) are bearer tokens prefixed umami_.
      // Umami 3.0.3 has no API keys, so that version connects with a username
      // and password. Cloud keys are not bearer tokens and use this header.
      if (credentials.secret.startsWith("umami_")) {
        return Promise.resolve({
          authorization: `Bearer ${credentials.secret}`,
        });
      }
      return Promise.resolve({ "x-umami-api-key": credentials.secret });
    }
    authPromise ??= login();
    return authPromise;
  }

  return {
    async listWebsites(): Promise<UmamiWebsite[]> {
      const websites: UmamiWebsite[] = [];
      for (let page = 1; page <= MAX_WEBSITE_PAGES; page++) {
        const params = new URLSearchParams({
          includeTeams: "true",
          page: String(page),
          pageSize: String(WEBSITE_PAGE_SIZE),
        });
        const result = parse(
          websiteListSchema,
          await send(`/websites?${params}`, { auth: true }),
        );
        websites.push(...result.data);
        const total = result.count ?? websites.length;
        if (result.data.length < WEBSITE_PAGE_SIZE || websites.length >= total)
          break;
      }
      return websites;
    },

    async getWebsite(websiteId: string): Promise<UmamiWebsite> {
      return parse(
        websiteSchema,
        await send(websitePath(websiteId), { auth: true }),
      );
    },

    /** Totals for the window. Umami v2 answers with `{ value, prev }`
     *  objects instead of numbers and has no regex filters, so it is
     *  rejected rather than read as zeros. */
    async getStats(
      websiteId: string,
      range: UmamiTimeRange,
      filters: { referrer?: string } = {},
    ): Promise<UmamiStats> {
      const body = await send(
        `${websitePath(websiteId)}/stats?${query(range, filters)}`,
        { auth: true },
      );
      if (
        typeof body === "object" &&
        body !== null &&
        typeof Reflect.get(body, "pageviews") === "object"
      ) {
        throw new UmamiError(
          "umami_unsupported_version",
          "This Umami server runs v2. OpenSEO needs Umami v3 or newer.",
        );
      }
      return parse(statsSchema, body);
    },

    async getSeries(
      websiteId: string,
      range: UmamiTimeRange,
      input: { unit: "day" | "month"; timeZone: string; referrer?: string },
    ) {
      const fetchSeries = async (referrer: string | undefined) =>
        parse(
          pageviewSeriesSchema,
          await send(
            `${websitePath(websiteId)}/pageviews?${query(range, {
              unit: input.unit,
              timezone: input.timeZone,
              referrer,
            })}`,
            { auth: true },
          ),
        );
      if (!isOrganicReferrerFilter(input.referrer)) {
        return fetchSeries(input.referrer);
      }
      const parts = await Promise.all(
        ORGANIC_REFERRER_CONTAINS.map((domain) => fetchSeries(`c.${domain}`)),
      );
      return {
        pageviews: mergePoints(parts.map((part) => part.pageviews)),
        sessions: mergePoints(parts.map((part) => part.sessions)),
      };
    },

    async getExpandedMetrics(
      websiteId: string,
      range: UmamiTimeRange,
      input: {
        type: UmamiExpandedMetricType;
        limit: number;
        offset: number;
        referrer?: string;
      },
    ): Promise<UmamiExpandedMetric[]> {
      const fetchMetrics = async (
        referrer: string | undefined,
        paging: { limit: number; offset: number },
      ) =>
        parse(
          expandedMetricsSchema,
          await send(
            `${websitePath(websiteId)}/metrics/expanded?${query(range, {
              type: input.type,
              limit: paging.limit,
              offset: paging.offset,
              referrer,
            })}`,
            { auth: true },
          ),
        );
      if (!isOrganicReferrerFilter(input.referrer)) {
        return fetchMetrics(input.referrer, input);
      }
      // Each engine is its own query. Take enough rows to cover the requested
      // window, then merge and slice. A page that is past this window on every
      // engine is omitted.
      const window = input.offset + input.limit;
      const parts = await Promise.all(
        ORGANIC_REFERRER_CONTAINS.map((domain) =>
          fetchMetrics(`c.${domain}`, { limit: window, offset: 0 }),
        ),
      );
      return mergeMetrics(parts).slice(
        input.offset,
        input.offset + input.limit,
      );
    },
  };
}

export type UmamiClient = ReturnType<typeof createUmamiClient>;
