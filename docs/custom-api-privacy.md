# Custom API privacy and proxy sessions

Custom OpenAI-compatible, Anthropic-compatible and embedding connections have two optional settings in their Add and Edit dialogs. Bulk Add applies the settings to every imported key.

**Anonymize requests** removes client session, user, device and tracing identifiers, identifying metadata, cookies and client fingerprint headers before a request reaches the custom API. It also removes supported SDK telemetry fields and identifying URL parameters. API authentication and the request content still reach the upstream. The API key identifies its account, messages can reveal personal information, and a direct connection exposes the router's public IP. Server-provided `previous_response_id` and Responses conversation references are preserved so resumed conversations keep their context; the upstream can still link those calls. This setting does not guarantee anonymity.

**Pin account and proxy session** keeps the selected account and an opaque proxy session together. Normal round-robin and sticky limits do not rotate a healthy pinned account. If that account becomes unavailable, new requests use another available account. The old session accepts no new requests and remains reserved while its active responses finish or cancel upstream. It is retired only when all of those requests end. Cancelling one healthy stream releases that request without rotating the account.

Select an active session-capable HTTP or HTTPS proxy pool before saving pinning. A saved legacy connection proxy also works. SOCKS proxies and relay pools are unsupported. Pinning requires the proxy for every destination, including destinations listed in No Proxy, and fails if a supported proxy is unavailable. Enable pinning on every account that should participate in this behavior.

For Bright Data, use the normal proxy URL and zone credentials, for example:

```text
http://brd-customer-CUSTOMER-zone-ZONE:PASSWORD@brd.superproxy.io:33335
```

9Router supplies a random alphanumeric session ID and adds `-session-ID-const` to the username. An existing session selector is replaced. The `-const` suffix makes Bright Data return an error when its selected peer is unavailable instead of silently rotating the peer. For another proxy provider, put `{session}` in the username or password where that provider expects its sticky-session ID. URL-encoded `%7Bsession%7D` also works.

Sessions are held in the running 9Router process. Restarting 9Router creates new sessions. Different 9Router workers have independent account pins, so run a single worker for a shared account pool that needs this guarantee. Bright Data also documents a five-minute idle timeout and requires stable region and targeting parameters to preserve session context. Its network can stop serving a peer even while 9Router keeps the account pinned. See [Bright Data's proxy and IP rotation controls](https://docs.brightdata.com/api-reference/proxy/rotate_ips) for those limits.

Both settings require direct execution. Enabling either setting turns off **Use server Claude Code** for a custom Anthropic connection. API requests that combine them with `executionMode: "claude-code"` are rejected.

The saved flags live in `providerSpecificData`:

```json
{
  "anonymizeRequests": true,
  "customApiSessionPinning": true
}
```

When creating or updating a connection through `/api/providers`, pass `proxyPoolId` at the top level. The API validates the resulting saved configuration, including an existing pinning setting retained by a partial update. Removing the proxy while pinning remains enabled is rejected; disable pinning in the same update to remove its proxy.
