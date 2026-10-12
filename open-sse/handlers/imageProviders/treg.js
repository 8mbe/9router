import { TREG_CONFIG } from "../../config/treg.js";
import { nowSec, sleep } from "./_base.js";
import { fetchImageAsBase64, parseDataUri } from "../../translator/concerns/image.js";
import { buildTregGenerationBody, mediaItems } from "../treg/generation.js";
import { buildTregCallUrl, buildTregHeaders, getTregRoute, valueAt, pollTregTask, tregTaskStatus, tregTaskResult, assertTregTask, tregResponseHeaders, sanitizeTregMessage } from "../treg/client.js";

export default {
  noRetryAfterSubmission: true,
  sanitizeError: sanitizeTregMessage,
  fetchOptions: () => ({ redirect: "error", signal: AbortSignal.timeout(TREG_CONFIG.httpTimeoutMs) }),
  buildUrl(model) {
    const route = getTregRoute(model, "image");
    return buildTregCallUrl(model, route.query);
  },
  buildHeaders: (credentials) => buildTregHeaders(credentials),
  async buildBody(model, body) {
    const route = getTregRoute(model, "image");
    const sources = body.image_urls || (body.image || body.image_url ? [body.image || body.image_url] : []);
    if (route.format !== "google-image" || !sources.length) return buildTregGenerationBody(route, body);
    const request = buildTregGenerationBody(route, { ...body, image: null, image_url: null, image_urls: null });
    for (const source of sources) {
      const inline = parseDataUri(source) || parseDataUri((await fetchImageAsBase64(source))?.url);
      if (!inline || !inline.mimeType.startsWith("image/")) throw new Error("Invalid or inaccessible Treg source image");
      request.contents[0].parts.push({ inlineData: { mimeType: inline.mimeType, data: inline.base64 } });
    }
    return request;
  },
  responseHeaders: tregResponseHeaders,
  async parseResponse(response, { model, body, headers }) {
    const route = getTregRoute(model, "image");
    let data = await response.json();
    assertTregTask(data);
    let images;
    if (route.async) {
      const id = valueAt(data, route.async.id_from);
      if (!id) throw new Error("Treg image submission returned no task id");
      const deadline = Date.now() + TREG_CONFIG.imageTimeoutMs;
      while (tregTaskStatus(route, data) === "pending") {
        if (Date.now() >= deadline) throw new Error(`Treg image task timed out; task ${id} may still complete`);
        await sleep(Math.max(TREG_CONFIG.minPollIntervalMs, route.async.interval * 1000));
        data = await pollTregTask(route, id, headers, AbortSignal.timeout(Math.max(1, deadline - Date.now())));
      }
      if (tregTaskStatus(route, data) === "failed") throw new Error(`Treg image task ${id} failed`);
      images = mediaItems(await tregTaskResult(route, data, headers));
    } else if (route.format === "google-image") {
      images = (data.candidates || []).flatMap((candidate) => (candidate.content?.parts || []).flatMap((part) =>
        part.inlineData?.data && part.inlineData.mimeType?.startsWith("image/") ? [{ b64_json: part.inlineData.data }] : []));
    } else {
      images = mediaItems(data.data?.image_urls || data.data?.image_base64 || data.data);
      if (Array.isArray(data.data?.image_base64)) images = data.data.image_base64.map((b64_json) => ({ b64_json }));
    }
    if (!images.length) throw new Error("Treg image generation returned no images");
    if (body.response_format === "b64_json") {
      images = await Promise.all(images.map(async (item) => {
        if (item.b64_json) return item;
        const downloaded = await fetchImageAsBase64(item.url);
        const inline = parseDataUri(downloaded?.url);
        if (!inline) throw new Error("Treg generated image could not be downloaded");
        return { b64_json: inline.base64 };
      }));
    }
    return { created: nowSec(), data: images };
  },
  normalize: (data) => data,
};
