# Treg

Treg is an API aggregator. Add an organization API token as a Treg connection in the media providers dashboard. The connection is shared by Text to Image, Video, Text to Speech, Web Search, and Web Fetch.

9Router sends `X-Treg-Token` to Treg. Treg uses your connected provider credentials first, then its own credentials against your team's prepaid balance. For a personal identity token, store the team slug in `providerSpecificData.org` to send `X-Treg-Org`.

The integration has 25 configured model routes: 15 image, 7 video, and 3 speech routes. Image models include FLUX Schnell, Nano Banana, GPT Image, and MiniMax Image. Video models include H3, Hailuo, Seedance, and Veo. Speech uses MiniMax Speech 2.8 or Fish Audio S2.1 Pro. Routes of the same model remain separate, so you choose the upstream provider explicitly.

Token and model checks use read-only identity and catalog requests. They verify authentication and catalog registration. Generating media uses the endpoints below and may charge the Treg balance.

## Images

```sh
curl http://localhost:20127/v1/images/generations \
  -H 'Authorization: Bearer YOUR_9ROUTER_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"treg/replicate.image-gen.flux-schnell","prompt":"A paper boat on a quiet pond","size":"1024x1024","n":1}'
```

Async image routes submit once and poll the configured Treg task endpoint. The response is an OpenAI image response with `data[].url` or `data[].b64_json`. Use `response_format: "b64_json"` for base64 output. Routes that support source images also accept `image` or `image_urls`.

`provider_options` accepts the native fields declared for a configured route. For example, Replicate options go under `provider_options.input`; MiniMax H3's model variant goes under `provider_options.model`. Generic request fields override corresponding native options. Treg call IDs and reported costs are returned as `X-Treg-Call-Id` and `X-Treg-Cost-Micro` on image and video responses.

## Videos

```sh
curl http://localhost:20127/v1/videos/generations \
  -H 'Authorization: Bearer YOUR_9ROUTER_KEY' \
  -H 'Content-Type: application/json' \
  -d '{"model":"treg/minimax.video-gen.h3.generate","prompt":"A paper boat drifts across a pond","duration":5,"resolution":"480P","aspect_ratio":"16:9"}'
```

The response contains a `request_id`, `status: "pending"`, and `poll_after_seconds`. Keep that ID and poll after the stated interval:

```sh
curl http://localhost:20127/v1/videos/RETURNED_REQUEST_ID \
  -H 'Authorization: Bearer YOUR_9ROUTER_KEY'
```

The job ID retains the model route and serving connection. Polling uses that connection and applies the API key's model restrictions. If the connection is unavailable, polling returns an error. It does not start another job or switch accounts. A completed response includes `video.url`; a failed response includes `status: "failed"`.

For image-to-video, pass `image` with the source URL. The `minimax.video-gen.from_image` route requires it. H3 also accepts two URLs in `image_urls` as the first and last frames. Native H3 reference content can go in `provider_options.content`. Video edits and extensions are not exposed by these routes.

## Speech and web

```json
{"model":"treg/minimax.voice-gen.speech-2-8-hd","input":"Hello from 9Router","voice":"English_expressive_narrator","response_format":"mp3"}
```

Send this body to `/v1/audio/speech`. Fish Audio uses `treg/fishaudio.tts.s2-1-pro` and an optional Fish voice ID in `voice`. Speech returns audio bytes, or base64 audio with `response_format: "json"`.

```json
{"model":"treg","query":"latest battery research","max_results":5,"search_type":"web"}
```

Send this body to `/v1/search`. The routed search supports a query and result limit. News search, country/language filters, date filters, offsets, and domain filters are rejected.

```json
{"model":"treg","url":"https://example.com","format":"markdown","max_characters":10000}
```

Send this body to `/v1/web/fetch`. The response reports the format actually returned by the upstream extractor. Markdown and text are supported.

Treg also offers music and other catalog tools. They are not registered here because 9Router has no music generation API handler, and the remaining tools do not map to the existing media endpoints. The configured video routes return public media URLs; OpenRouter's binary video download routes are not included.

API reference: [Treg documentation](https://treg.to/llms.txt) and [live catalog](https://treg.to/catalog/platforms).
