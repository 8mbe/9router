import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns", () => ({
  default: { promises: { lookup: lookupMock } },
  promises: { lookup: lookupMock },
}));

import { buildSearchRequest } from "../../open-sse/handlers/search/callers.js";
import { normalizeSearchResponse } from "../../open-sse/handlers/search/normalizers.js";
import { handleSearchCore } from "../../open-sse/handlers/search/index.js";
import { handleFetchCore } from "../../open-sse/handlers/fetch/index.js";

const URL = "https://example.com/article";
const SEARCH_CONFIG = {
  id: "treg", baseUrl: "https://treg.to/call/treg.web.search", authType: "apiKey",
  searchTypes: ["web"], defaultMaxResults: 5, maxMaxResults: 20, timeoutMs: 15000,
};
const FETCH_CONFIG = { baseUrl: "https://treg.to/call/treg.web.extract", timeoutMs: 15000 };
const CREDENTIALS = { apiKey: "treg-test-token", providerSpecificData: { org: "test-team" } };

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });
}

function runSearch(body = {}) {
  return handleSearchCore({ body: { query: "new release", max_results: 2, ...body },
    provider: { id: "treg" }, providerConfig: SEARCH_CONFIG, credentials: CREDENTIALS });
}

function runFetch(options = {}) {
  return handleFetchCore({ url: URL, provider: "treg", providerConfig: FETCH_CONFIG,
    credentials: CREDENTIALS, ...options });
}

beforeEach(() => {
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
});

afterEach(() => vi.unstubAllGlobals());

describe("Treg routed web search", () => {
  it("sends the declared q and limit with token and organization headers", () => {
    const request = buildSearchRequest(SEARCH_CONFIG, {
      query: "new release", maxResults: 2, searchType: "web", token: CREDENTIALS.apiKey,
      providerSpecificData: CREDENTIALS.providerSpecificData,
      providerOptions: { baseUrl: "https://example.org/collect", unknown: "ignored" },
    });
    expect(request.url).toBe(SEARCH_CONFIG.baseUrl);
    expect(request.init.method).toBe("POST");
    expect(request.init.headers).toMatchObject({
      "X-Treg-Token": "treg-test-token", "X-Treg-Org": "test-team", "X-Treg-Route-Strict-Filters": "1",
    });
    expect(request.init.headers.Authorization).toBeUndefined();
    expect(JSON.parse(request.init.body)).toEqual({ q: "new release", limit: 2 });
  });

  it.each([
    [{ searchType: "news" }, "only the web search type"],
    [{ country: "US" }, "country"],
    [{ language: "en" }, "language"],
    [{ timeRange: "month" }, "time_range"],
    [{ offset: 2 }, "offset"],
    [{ domainFilter: ["example.com"] }, "domain_filter"],
    [{ contentOptions: { full_page: true } }, "content_options.full_page"],
  ])("rejects unsupported search inputs %j before sending them", (unsupported, error) => {
    expect(() => buildSearchRequest(SEARCH_CONFIG, {
      query: "new release", maxResults: 2, token: CREDENTIALS.apiKey, ...unsupported,
    })).toThrow(error);
  });

  it("normalizes provider-native rows inside the routed envelope and caps results", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      output: { count: 3, results: [
        { name: "Release", link: URL, description: "A release", publishedDate: "2026-10-11", text: "Full article" },
        { title: "Another release", url: `${URL}/2`, snippets: ["Second release"], markdown: "# Second" },
        { title: "Extra", url: `${URL}/3`, content: "Third release" },
      ] },
      raw: { organic: [{ title: "Raw should not replace output" }] },
      _treg: { served_by: "serper.web.search", tried: ["tinyfish.web.search", "serper.web.search"] },
    })));
    const result = await runSearch();
    expect(result.success).toBe(true);
    expect(result.data.results).toHaveLength(2);
    expect(result.data.results[0]).toMatchObject({
      title: "Release", url: URL, snippet: "A release", published_at: "2026-10-11",
      content: { format: "text", text: "Full article", length: 12 },
      citation: { provider: "treg", rank: 1 },
    });
    expect(result.data.results[1]).toMatchObject({
      snippet: "Second release", content: { format: "markdown", text: "# Second" },
    });
    expect(result.data.metrics.total_results_available).toBe(3);
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ q: "new release", limit: 2 });
    expect(fetch.mock.calls[0][1].headers["X-Treg-Org"]).toBe("test-team");
  });

  it("accepts a bare output contract and a genuine routed miss", () => {
    expect(normalizeSearchResponse("treg", { results: [{ title: "Release", url: URL }] }).results[0].title).toBe("Release");
    expect(normalizeSearchResponse("treg", { output: { results: [], count: 0 }, _treg: { outcome: "miss" } }))
      .toEqual({ results: [], totalResults: 0 });
  });

  it.each([
    [{ raw: { results: [] } }, "missing output.results"],
    [{ output: { results: [null] } }, "invalid search result"],
    [{ output: { results: [] }, _treg: { outcome: "pending" } }, "still pending"],
    [{ detail: "Insufficient balance" }, "Insufficient balance"],
  ])("reports invalid and failed responses %j", async (response, error) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(response)));
    expect(await runSearch()).toMatchObject({ success: false, status: 502, error: expect.stringContaining(error) });
  });

  it("preserves Treg HTTP failures and rejects filters without a network call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "Invalid token" }, 401)));
    expect(await runSearch()).toMatchObject({ success: false, status: 401, error: expect.stringContaining("Invalid token") });
    fetch.mockClear();
    expect(await runSearch({ country: "US" })).toMatchObject({ success: false, status: 400, error: expect.stringContaining("country") });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("Treg routed web extraction", () => {
  it("sends only url and maps Markdown, metadata, truncation and routed cost", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      output: { pages: [{ markdown: "# Example article", links: [URL], metadata: {
        title: "Example", author: "Writer", language: "en", published_date: "2026-10-11",
      } }], count: 1 },
      _treg: { served_by: "firecrawl.web.scrape", charged_micro: 5000 },
    })));
    const result = await runFetch({ maxCharacters: 9 });
    expect(result.success).toBe(true);
    expect(fetch.mock.calls[0][0]).toBe(FETCH_CONFIG.baseUrl);
    expect(fetch.mock.calls[0][1].headers).toMatchObject({ "X-Treg-Token": CREDENTIALS.apiKey, "X-Treg-Org": "test-team" });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ url: URL });
    expect(result.data).toMatchObject({
      provider: "treg", url: URL, title: "Example", content: { text: "# Example", format: "markdown", length: 9 },
      metadata: { author: "Writer", language: "en", published_at: "2026-10-11" },
      links: [URL], usage: { fetch_cost_usd: 0.005 },
    });
  });

  it.each([
    [{ text: "Plain content", title: "Page" }, "markdown", "text", "Plain content"],
    [{ raw_content: "Raw text" }, "text", "text", "Raw text"],
    [{ markdown: { raw_markdown: "# Markdown" } }, "text", "markdown", "# Markdown"],
    [{ excerpts: ["First", "Second"] }, "text", "text", "First\n\nSecond"],
    [{ text: "# Native Markdown", format: "markdown" }, "text", "markdown", "# Native Markdown"],
    [{ markdown: "", text: "Nonempty content" }, "markdown", "text", "Nonempty content"],
  ])("reports the content format actually returned for %j", async (page, requestedFormat, actualFormat, text) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ output: { pages: [page] } }, 200, { "X-Treg-Cost-Micro": "150" })));
    const result = await runFetch({ format: requestedFormat });
    expect(result.data.content).toEqual({ text, format: actualFormat, length: text.length });
    expect(result.data.usage.fetch_cost_usd).toBe(0.00015);
  });

  it.each([
    [{ output: { pages: [] } }, "no extractable page content"],
    [{ raw: { results: [{ text: "Content" }] } }, "no extractable page content"],
    [{ output: { pages: [{ title: "No content" }] } }, "no extractable page content"],
    [{ output: { pages: [{ markdown: "", text: "" }] } }, "no extractable page content"],
    [{ output: { pages: [{ error: "bot_blocked" }] } }, "bot_blocked"],
    [{ output: { pages: [{ ok: false, reason: "blocked", markdown: "Error page" }] } }, "blocked"],
    [{ output: { pages: [{ text: "Not found", status_code: 404 }] } }, "page extraction failed"],
    [{ output: { pages: [] }, _treg: { outcome: "pending" } }, "still pending"],
    [{ detail: "Insufficient balance" }, "Insufficient balance"],
  ])("reports malformed, missing and failed page responses %j", async (response, error) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(response)));
    expect(await runFetch()).toMatchObject({ success: false, status: 502, error: expect.stringContaining(error) });
  });

  it("preserves HTTP errors and validates formats and credentials before calling", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ detail: "Invalid token" }, 401)));
    expect(await runFetch()).toMatchObject({ success: false, status: 401, error: "Invalid token" });
    fetch.mockClear();
    expect(await runFetch({ format: "html" })).toMatchObject({ success: false, status: 400 });
    expect(await runFetch({ credentials: {} })).toMatchObject({ success: false, status: 401 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports network aborts as timeouts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new DOMException("Timed out", "AbortError"); }));
    expect(await runFetch()).toMatchObject({ success: false, status: 504, error: "Timed out" });
  });
});
