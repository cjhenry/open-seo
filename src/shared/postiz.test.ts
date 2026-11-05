import { describe, expect, it } from "vitest";
import {
  calendarMonth,
  dayKey,
  toPublishedLivePosts,
  type PostizPostRecord,
} from "./postiz";

const published = (
  overrides: Partial<PostizPostRecord> = {},
): PostizPostRecord => ({
  id: "post-1",
  content: "Hello",
  publishDate: "2026-11-05T15:00:00.000Z",
  releaseUrl: "https://www.facebook.com/example/posts/1",
  state: "PUBLISHED",
  settings: null,
  provider: "facebook",
  channelName: "Example Page",
  ...overrides,
});

describe("published Postiz posts", () => {
  it("keeps published posts and reads UTM params from the release URL and the linked destination", () => {
    const posts = toPublishedLivePosts([
      published({
        content:
          "See https://www.example.com/events?utm_source=postiz&utm_medium=social&utm_campaign=facebook-open-house.",
      }),
      published({
        id: "post-2",
        provider: "linkedin-page",
        channelName: "Example Page",
        releaseUrl:
          "https://www.linkedin.com/feed/update/1?UTM_SOURCE=postiz&utm_medium=social&utm_campaign=linkedin-search-guide",
        content: "No tracked link here.",
        settings: {
          url: "https://www.example.com/guide?utm_source=postiz&utm_medium=social&utm_campaign=linkedin-search-guide",
        },
      }),
      published({
        id: "draft",
        state: "DRAFT",
        content: "Not live",
      }),
      published({
        id: "queued",
        state: "QUEUE",
      }),
    ]);

    expect(posts.map((post) => post.id)).toEqual(["post-1", "post-2"]);
    expect(posts[0]?.channel).toEqual({
      provider: "facebook",
      label: "Facebook",
      name: "Example Page",
    });
    expect(posts[0]?.trackedLinks).toEqual([
      {
        url: "https://www.example.com/events?utm_source=postiz&utm_medium=social&utm_campaign=facebook-open-house",
        utm: {
          source: "postiz",
          medium: "social",
          campaign: "facebook-open-house",
        },
      },
    ]);
    expect(posts[0]?.releaseUtm).toBeNull();
    expect(posts[1]?.channel.label).toBe("LinkedIn Page");
    expect(posts[1]?.releaseUtm).toEqual({
      source: "postiz",
      medium: "social",
      campaign: "linkedin-search-guide",
    });
    expect(posts[1]?.trackedLinks[0]?.utm.campaign).toBe(
      "linkedin-search-guide",
    );
  });
});

describe("calendar days", () => {
  it("places a late Cayman evening on that local day, not the next UTC day", () => {
    expect(dayKey("2026-11-05T04:30:00.000Z", "America/Cayman")).toBe(
      "2026-11-04",
    );

    const november = calendarMonth("2026-11", "America/Cayman");
    expect(november?.startIso).toBe("2026-11-01T05:00:00.000Z");
    expect(november?.cells[0]).toEqual({ date: "2026-11-01", inMonth: true });
    expect(november?.label).toBe("November 2026");
  });
});
