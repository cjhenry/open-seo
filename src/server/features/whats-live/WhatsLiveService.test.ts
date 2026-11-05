import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsLiveService } from "./WhatsLiveService";

const fetchMock = vi.fn<typeof fetch>();

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  return input instanceof URL ? input.href : input.url;
}

describe("WhatsLiveService", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("POSTIZ_API_URL", "https://social.example.test/api");
    vi.stubEnv("POSTIZ_WORK_API_KEY", "work-key");
    vi.stubEnv("POSTIZ_USE_FIXTURES", "");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("reads published posts from the public API with the work key", async () => {
    fetchMock.mockResolvedValue(
      Response.json({
        posts: [
          {
            id: "live-1",
            content: "Published",
            publishDate: "2026-11-03T15:00:00.000Z",
            releaseURL: "https://www.facebook.com/example/posts/live",
            state: "PUBLISHED",
            integration: {
              providerIdentifier: "facebook",
              name: "Example Page",
            },
          },
          {
            id: "draft-1",
            content: "Draft",
            publishDate: "2026-11-03T16:00:00.000Z",
            state: "DRAFT",
            integration: {
              providerIdentifier: "facebook",
              name: "Example Page",
            },
          },
        ],
      }),
    );

    const result = await WhatsLiveService.list({
      month: "2026-11",
      timeZone: "America/Cayman",
    });

    expect(result.status).toBe("ok");
    expect(result.source).toBe("live");
    expect(result.posts.map((post) => post.id)).toEqual(["live-1"]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] ?? [];
    const url = new URL(requestUrl(input!));
    expect(url.origin + url.pathname).toBe(
      "https://social.example.test/api/public/v1/posts",
    );
    expect(url.searchParams.get("startDate")).toBe("2026-11-01T05:00:00.000Z");
    expect(new Headers(init?.headers).get("authorization")).toBe("work-key");
  });

  it("accepts an API root that already includes /public/v1", async () => {
    vi.stubEnv("POSTIZ_API_URL", "https://social.example.test/api/public/v1/");
    fetchMock.mockResolvedValue(Response.json({ posts: [] }));

    await WhatsLiveService.list({
      month: "2026-11",
      timeZone: "UTC",
    });

    const url = new URL(requestUrl(fetchMock.mock.calls[0]?.[0] ?? ""));
    expect(url.pathname).toBe("/api/public/v1/posts");
  });

  it("does not call Postiz when the work key is missing", async () => {
    vi.stubEnv("POSTIZ_WORK_API_KEY", "");
    vi.stubEnv("POSTIZ_API_URL", "");

    const result = await WhatsLiveService.list({
      month: "2026-11",
      timeZone: "UTC",
    });

    expect(result.status).toBe("unconfigured");
    expect(result.posts).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows sample posts with Postiz UTM params when fixtures are on and no key is set", async () => {
    vi.stubEnv("POSTIZ_WORK_API_KEY", "");
    vi.stubEnv("POSTIZ_API_URL", "");
    vi.stubEnv("POSTIZ_USE_FIXTURES", "true");

    const result = await WhatsLiveService.list({
      month: "2026-11",
      timeZone: "America/Cayman",
    });

    expect(result.source).toBe("fixture");
    expect(result.posts.map((post) => post.id)).toEqual([
      "fixture-x",
      "fixture-linkedin",
      "fixture-facebook",
    ]);
    expect(
      result.posts.find((post) => post.id === "fixture-facebook")
        ?.trackedLinks[0]?.utm,
    ).toEqual({
      source: "postiz",
      medium: "social",
      campaign: "facebook-open-house",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports a rejected work key without echoing the key", async () => {
    vi.stubEnv("POSTIZ_WORK_API_KEY", "super-secret-work-key");
    fetchMock.mockResolvedValue(new Response("nope", { status: 401 }));

    const result = await WhatsLiveService.list({
      month: "2026-11",
      timeZone: "UTC",
    });

    expect(result.status).toBe("error");
    expect(result.message).toContain("POSTIZ_WORK_API_KEY");
    expect(result.message).not.toContain("super-secret-work-key");
  });
});
