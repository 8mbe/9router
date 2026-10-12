import { TREG_CONFIG } from "../../config/treg.js";
import { buildTregGenerationBody, encodeTregJob, decodeTregJob, mediaItems } from "../treg/generation.js";
import { buildTregCallUrl, buildTregHeaders, getTregRoute, valueAt, tregTaskStatus, tregTaskResult, assertTregTask, tregResponseHeaders } from "../treg/client.js";

export default {
  fetchOptions: { redirect: "error" },
  buildRequest({ action, requestId, rawBody, contentType, credentials, idempotencyKey }) {
    try {
      const headers = buildTregHeaders(credentials, idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {});
      if (requestId) {
        const { route, taskId } = decodeTregJob(requestId);
        return { method: "GET", url: buildTregCallUrl(route.async.poll.endpoint, { [route.async.poll.param.name]: taskId }), headers };
      }
      if (action !== "generations") return { error: "Treg video supports generations only; pass an image for image-to-video" };
      if (contentType && !contentType.includes("application/json")) return { error: "Treg video requires application/json" };
      const body = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
      const route = getTregRoute(body.model, "video");
      if (!body.prompt && !body.provider_options?.content) return { error: "Treg video requires prompt" };
      return { method: "POST", url: buildTregCallUrl(body.model, route.query), headers, body: JSON.stringify(buildTregGenerationBody(route, body)) };
    } catch (error) {
      return { error: error.message };
    }
  },
  responseHeaders: tregResponseHeaders,
  async parseResponse(data, { requestId, rawBody, credentials, signal }) {
    assertTregTask(data);
    let route, id;
    if (requestId) {
      ({ route } = decodeTregJob(requestId));
      id = requestId;
    } else {
      const body = JSON.parse(typeof rawBody === "string" ? rawBody : rawBody.toString("utf8"));
      route = getTregRoute(body.model, "video");
      const taskId = valueAt(data, route.async.id_from);
      if (!taskId) throw new Error("Treg video submission returned no task id");
      id = encodeTregJob(body.model, taskId, credentials?.connectionId);
    }
    const status = tregTaskStatus(route, data);
    const result = { id, request_id: id, status };
    if (status === "failed") return { ...result, error: { message: "Treg provider failed the video task" } };
    if (status === "pending") return { ...result, poll_after_seconds: Math.max(30, route.async.interval) };
    const videos = mediaItems(await tregTaskResult(route, data, buildTregHeaders(credentials), signal));
    if (!videos.length) throw new Error("Treg completed task returned no video URL");
    return { ...result, video: videos[0], videos };
  },
};
