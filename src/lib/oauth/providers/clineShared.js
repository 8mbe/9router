/**
 * Cline OAuth flow, shared by the `cline`, `clinepass` and `cline-free` providers.
 *
 * All three sign in against the same app.cline.bot / api.cline.bot endpoints with
 * an authorization_code flow that carries no PKCE: Cline's callback hands back a
 * base64-encoded token blob in the `code` param, and only falls back to a real
 * token-endpoint exchange when that blob can't be decoded.
 *
 * @param {object} config - PROVIDER_OAUTH entry for the provider
 * @param {string} label - Provider name used in exchange error messages
 */
export function createClineOAuthProvider(config, label) {
  return {
    config,
    flowType: "authorization_code",
    buildAuthUrl: (cfg, redirectUri) => {
      const params = new URLSearchParams({
        client_type: "extension",
        callback_url: redirectUri,
        redirect_uri: redirectUri,
      });
      return `${cfg.authorizeUrl}?${params.toString()}`;
    },
    exchangeToken: async (cfg, code, redirectUri) => {
      try {
        // Cline encodes token data as base64 in the code param
        let base64 = code;
        const padding = 4 - (base64.length % 4);
        if (padding !== 4) base64 += "=".repeat(padding);
        const decoded = Buffer.from(base64, "base64").toString("utf-8");
        const lastBrace = decoded.lastIndexOf("}");
        if (lastBrace === -1) throw new Error("No JSON found in decoded code");
        const tokenData = JSON.parse(decoded.substring(0, lastBrace + 1));
        return {
          access_token: tokenData.accessToken,
          refresh_token: tokenData.refreshToken,
          email: tokenData.email,
          firstName: tokenData.firstName,
          lastName: tokenData.lastName,
          expires_at: tokenData.expiresAt,
        };
      } catch {
        const response = await fetch(cfg.tokenExchangeUrl || cfg.tokenUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            grant_type: "authorization_code",
            code,
            client_type: "extension",
            redirect_uri: redirectUri,
          }),
        });
        if (!response.ok) {
          const error = await response.text();
          throw new Error(`${label} token exchange failed: ${error}`);
        }
        const data = await response.json();
        return {
          access_token: data.data?.accessToken || data.accessToken,
          refresh_token: data.data?.refreshToken || data.refreshToken,
          email: data.data?.userInfo?.email || "",
          expires_at: data.data?.expiresAt || data.expiresAt,
        };
      }
    },
    mapTokens: (tokens) => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresIn: tokens.expires_at
        ? Math.floor((new Date(tokens.expires_at).getTime() - Date.now()) / 1000)
        : 3600,
      email: tokens.email,
      providerSpecificData: { firstName: tokens.firstName, lastName: tokens.lastName },
    }),
  };
}
