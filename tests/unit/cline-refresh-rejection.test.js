import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refreshProviderCredentials: vi.fn(),
  updateProviderConnection: vi.fn(),
}));

vi.mock("../../src/lib/localDb.js", () => ({
  updateProviderConnection: mocks.updateProviderConnection,
}));

vi.mock("open-sse/services/oauthCredentialManager.js", async (importOriginal) => ({
  ...(await importOriginal()),
  refreshProviderCredentials: mocks.refreshProviderCredentials,
}));

const { checkAndRefreshToken } = await import("../../src/sse/services/tokenRefresh.js");

describe("rejected Cline refresh tokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateProviderConnection.mockResolvedValue({ id: "cline-1" });
  });

  it("marks the account for sign-in without replacing its stored tokens", async () => {
    mocks.refreshProviderCredentials.mockResolvedValue({ error: "invalid_grant" });

    const credentials = {
      id: "cline-1",
      provider: "cline",
      refreshToken: "old-refresh-token",
      accessToken: "old-access-token",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    };
    const result = await checkAndRefreshToken("cline", credentials, { force: true });

    expect(mocks.updateProviderConnection).toHaveBeenCalledWith("cline-1", expect.objectContaining({
      testStatus: "expired",
      lastErrorType: "token_refresh_failed",
      errorCode: 401,
    }), { expectedRefreshToken: "old-refresh-token" });
    expect(result.refreshToken).toBe("old-refresh-token");
    expect(result.accessToken).toBe("old-access-token");
  });

  it("does not mark transient refresh failures as expired", async () => {
    mocks.refreshProviderCredentials.mockResolvedValue(null);

    await checkAndRefreshToken("cline", {
      id: "cline-1",
      refreshToken: "retryable",
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    }, { force: true });

    expect(mocks.updateProviderConnection).not.toHaveBeenCalled();
  });
});
