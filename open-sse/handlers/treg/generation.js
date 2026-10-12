import { TREG_CONFIG, TREG_ROUTES } from "../../config/treg.js";
import { sizeToAspectRatio } from "../imageProviders/_base.js";

function ratioOf(body) {
  if (body.aspect_ratio) return body.aspect_ratio;
  if (/^\d+:\d+$/.test(body.size || "")) return body.size;
  if (body.size && body.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(body.size);
    if (!match || !Number(match[1]) || !Number(match[2])) throw new Error("Treg image size must be WIDTHxHEIGHT or auto");
    const standard = sizeToAspectRatio(body.size);
    if (standard !== "1:1" || match[1] === match[2]) return standard;
    const gcd = (a, b) => b ? gcd(b, a % b) : a;
    const width = Number(match[1]), height = Number(match[2]), divisor = gcd(width, height);
    return `${width / divisor}:${height / divisor}`;
  }
  return sizeToAspectRatio(body.size);
}

export function buildTregGenerationBody(route, body) {
  const options = body.provider_options || {};
  if (typeof options !== "object" || Array.isArray(options)) throw new Error("provider_options must be an object");
  const nested = route.format === "replicate" || route.format === "piapi";
  const allowed = new Set(nested ? Object.keys(route.defaults) : [...route.fields, ...Object.keys(route.defaults)]);
  for (const field of Object.keys(options)) {
    if (!allowed.has(field)) throw new Error(`Unsupported Treg provider option: ${field}`);
  }
  if (nested && options.input != null) {
    if (typeof options.input !== "object" || Array.isArray(options.input)) throw new Error("provider_options.input must be an object");
    for (const field of Object.keys(options.input)) {
      if (!route.fields.includes(field)) throw new Error(`Unsupported Treg input option: ${field}`);
    }
  }
  const request = { ...structuredClone(route.defaults), ...options };
  const fields = route.fields;
  const images = body.image_urls || (body.image || body.image_url ? [body.image || body.image_url] : null);
  if (body.n != null && (!Number.isInteger(body.n) || body.n < 1)) throw new Error("n must be a positive integer");

  if (route.format === "google-image") {
    if (body.n > 1) throw new Error("This Treg image model supports one image per request");
    if (images) throw new Error("For Gemini source images, use provider_options.contents with native inlineData parts");
    request.contents ||= [{ parts: [{ text: body.prompt }] }];
    request.generationConfig = { ...request.generationConfig, responseModalities: ["IMAGE"], imageConfig: {
      ...route.defaults.generationConfig?.imageConfig, ...request.generationConfig?.imageConfig,
      ...((body.size && body.size !== "auto") || body.aspect_ratio ? { aspectRatio: ratioOf(body) } : {}),
      ...(body.resolution ? { imageSize: body.resolution } : {}),
    } };
    return request;
  }

  const target = nested ? (request.input = { ...route.defaults.input, ...options.input }) : request;
  for (const field of fields) {
    if (["quality", "background"].includes(field) && body[field] === "auto") continue;
    if (body[field] != null && !["model", "input", "size", "n", "image", "image_urls"].includes(field)) target[field] = body[field];
  }
  if (fields.includes("aspect_ratio") && (body.aspect_ratio || (body.size && body.size !== "auto"))) target.aspect_ratio = ratioOf(body);
  if (route.sizeIsRatio && (body.aspect_ratio || (body.size && body.size !== "auto"))) target.size = ratioOf(body);
  else if (fields.includes("size") && body.size && body.size !== "auto") target.size = body.size;
  if (fields.includes("response_format") && body.response_format === "b64_json") target.response_format = "base64";
  const nField = ["n", "num_outputs", "number_of_images"].find((field) => fields.includes(field));
  if (body.n != null && nField) target[nField] = body.n;
  else if (body.n > 1) throw new Error("This Treg image model supports one image per request");

  if (route.format === "minimax-h3") {
    request.content = options.content || [{ type: "text", text: body.prompt }];
    if (images) {
      request.content = [...request.content, ...images.map((url, index) => ({ type: "image_url", image_url: { url }, role: index === 0 ? "first_frame" : "last_frame" }))];
    }
    if (body.aspect_ratio) request.ratio = body.aspect_ratio;
  } else if (images) {
    const arrayField = ["image_urls", "image_input", "input_images"].find((field) => fields.includes(field));
    const scalarField = ["first_frame_image", "image"].find((field) => fields.includes(field));
    if (arrayField) target[arrayField] = images;
    else if (scalarField) target[scalarField] = images[0];
    else throw new Error("This Treg model does not accept source images");
  }
  if (fields.includes("first_frame_image") && !target.first_frame_image) throw new Error("This Treg video model requires image or first_frame_image");
  return request;
}

export function encodeTregJob(model, taskId, connectionId) {
  return `${TREG_CONFIG.videoJobPrefix}${Buffer.from(JSON.stringify([model, String(taskId), ...(connectionId ? [connectionId] : [])])).toString("base64url")}`;
}

export function decodeTregJob(id) {
  if (typeof id !== "string" || id.length > 4096 || !/^treg_[A-Za-z0-9_-]+$/.test(id)) throw new Error("Invalid Treg video job id");
  const encoded = id.slice(5);
  const buffer = Buffer.from(encoded, "base64url");
  if (buffer.toString("base64url") !== encoded) throw new Error("Invalid Treg video job id");
  const values = JSON.parse(buffer.toString());
  if (!Array.isArray(values) || ![2, 3].includes(values.length)) throw new Error("Invalid Treg video job id");
  const [model, taskId, connectionId] = values;
  if (connectionId != null && (typeof connectionId !== "string" || !connectionId || connectionId.length > 256)) throw new Error("Invalid Treg connection id");
  if (typeof model !== "string" || !Object.hasOwn(TREG_ROUTES, model) || TREG_ROUTES[model].kind !== "video" || typeof taskId !== "string" || !taskId || taskId.length > 1024) {
    throw new Error("Invalid Treg video job id");
  }
  return { model, taskId, connectionId, route: TREG_ROUTES[model] };
}

export function mediaItems(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((item) => {
    if (typeof item === "string" && /^https?:\/\//.test(item)) return [{ url: item }];
    if (item?.url) return [{ url: item.url }];
    if (item?.b64_json) return [{ b64_json: item.b64_json }];
    return [];
  });
}
