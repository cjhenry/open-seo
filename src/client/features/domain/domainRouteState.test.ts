import { describe, expect, it } from "vitest";
import { getDomainRouteState } from "./domainRouteState";
import { toScopeSearchParam } from "@/shared/researchScope";

describe("research scope resolution", () => {
  it.each([
    [{ domain: "example.com" }, "subdomains"],
    [{ domain: "example.com/blog" }, "subfolder"],
    [{ domain: "example.com", subdomains: true }, "subdomains"],
    [{ domain: "example.com", subdomains: false }, "domain"],
    [{ domain: "example.com", scope: "subfolder" as const }, "subdomains"],
  ])(
    "derives the scope from the input, migrating legacy params and ignoring unsupported scopes: %o",
    (search, scope) => {
      expect(getDomainRouteState(search).scope).toBe(scope);
    },
  );

  it("omits the scope param when it matches the input's default", () => {
    expect(toScopeSearchParam("example.com", "subdomains")).toBeUndefined();
    expect(toScopeSearchParam("example.com", "domain")).toBe("domain");
    expect(toScopeSearchParam("example.com/blog", "subfolder")).toBeUndefined();
    expect(toScopeSearchParam("example.com/blog", "exact_url")).toBe(
      "exact_url",
    );
  });
});

describe("getDomainRouteState", () => {
  const project = { locationCode: 2704, languageCode: "vi" };

  it.each([
    [
      {},
      {
        defaultLocationCode: 2704,
        locationCode: 2704,
        sentLocationCode: undefined,
      },
    ],
    [
      { loc: 2840 },
      { defaultLocationCode: 2704, locationCode: 2840, sentLocationCode: 2840 },
    ],
  ])(
    "uses the Labs-backed project market unless the URL names a location: %o",
    (search, expected) => {
      expect(getDomainRouteState(search, project)).toMatchObject(expected);
    },
  );

  it("keeps a Google-Ads-only project market in the picker", () => {
    const state = getDomainRouteState(
      {},
      { locationCode: 2352, languageCode: "is" },
    );

    expect(state.defaultLocationCode).toBe(2352);
    expect(state.locationCode).toBe(2352);
    // Ads-only markets are not sent to Labs-backed domain endpoints.
    expect(state.sentLocationCode).toBeUndefined();
  });

  it("accepts a Google-Ads-only URL location without sending it to Labs", () => {
    const state = getDomainRouteState({ loc: 2352 }, project);

    expect(state.defaultLocationCode).toBe(2704);
    expect(state.locationCode).toBe(2352);
    expect(state.sentLocationCode).toBeUndefined();
  });

  it("keeps Cayman Islands selectable for an Ads-only project", () => {
    const state = getDomainRouteState(
      {},
      { locationCode: 2136, languageCode: "en" },
    );
    expect(state.locationCode).toBe(2136);
    expect(state.sentLocationCode).toBeUndefined();
  });
});
