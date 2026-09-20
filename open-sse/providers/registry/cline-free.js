// Cline Free — the free Cline tier, run IN-PROCESS by 9router.
//
// The cline-api bridge (https://github.com/alesrg/cline-api, MIT) is folded into
// executors/cline-free.js: 9router loads @cline/core itself and drives a Cline turn
// directly, then synthesizes OpenAI-compatible SSE. Nothing to clone, no second
// server to start — `cline` ships as an optionalDependency, so `npm install` brings
// both the CLI (for `cline auth`) and the core the executor loads.
//
// Not to be confused with the `cline` / `clinepass` entries, which are real HTTP
// calls to api.cline.bot with a stored credential. This one has no wire auth at
// all: it reuses the session `cline auth` wrote to ~/.cline, so it is a no-auth
// free provider (virtual connection, see src/sse/services/auth.js).
//
// Setup: `npx cline auth` once. Optional env:
//   CLINE_ENABLE_TOOLS=1    let Cline use its fs/shell tools (off by default —
//                           they run as the 9router process user)
//   CLINE_WORKSPACE_ROOT    working directory for those tools (default: cwd)
//   CLINE_CORE_INDEX        explicit path to @cline/core's dist/index.js
//
// Cline does not speak OpenAI function calling (its tools are server-side): the
// executor builds Cline's own turn config, so a request's `tools` /
// `parallel_tool_calls` are simply never forwarded.
export default {
  id: "cline-free",
  priority: 50,
  hasFree: true,
  alias: "clf",
  uiAlias: "clf",
  display: {
    name: "Cline Free",
    icon: "smart_toy",
    color: "#5B9BD5",
    textIcon: "CF",
    website: "https://cline.bot",
    notice: {
      signupUrl: "https://cline.bot",
      text: "Runs Cline in-process — nothing extra to install. Log in once with `npx cline auth`, then pick a model. Cline's own fs/shell tools are off by default; set CLINE_ENABLE_TOOLS=1 (and CLINE_WORKSPACE_ROOT) to enable them. OpenAI function tools are not supported by Cline and are stripped.",
    },
  },
  category: "free",
  authType: "none",
  noAuth: true,
  authModes: ["none"],
  transport: {
    // In-process marker, not a real endpoint — ClineFreeExecutor never dials out.
    baseUrl: "cline://core/inprocess",
    format: "openai",
    noAuth: true,
  },
  // Offline snapshot of Cline's free tier, kept only as the fallback for when the
  // live catalog cannot be read (no `cline auth` session, no network). The list
  // actually shown is fetched per request by services/clineFreeModels.js:
  // Cline's zero-priced catalog entries plus its own `cline-free/*` ids. Any other
  // id the account can serve still routes — see passthroughModels.
  models: [
    { id: "cline-free/deepseek-v4.1-flash", name: "Deepseek-v4.1-Flash" },
    { id: "cline-free/muse-spark-1.3-contributor", name: "Muse Spark 1.3 Contributor" },
    { id: "cline-free/solar-pro4", name: "Solar Pro 4" },
    { id: "inclusionai/ling-3.0-flash-vl:free", name: "inclusionAI: Ling 3.0 Flash VL (free)", contextLength: 262144 },
    { id: "nex-agi/nex-n2.5-mini:free", name: "Nex AGI: Nex-N2.5-Mini (free)", contextLength: 262144 },
    { id: "nex-agi/nex-n2.5-pro:free", name: "Nex AGI: Nex-N2.5-Pro (free)", contextLength: 262144 },
    { id: "inclusionai/ling-3.0-flash-sante:free", name: "inclusionAI: Ling 3.0 Flash Sante (free)", contextLength: 262144 },
    { id: "inclusionai/ling-3.0-flash-fin:free", name: "inclusionAI: Ling 3.0 Flash Fin (free)", contextLength: 262144 },
    { id: "qwen/qwen3.8-27b:free", name: "Qwen: Qwen3.8 27B (free)", contextLength: 262144 },
    { id: "dots-studio/dots-3-note-preview:free", name: "Dots Studio: Dots3-Note Preview (free)", contextLength: 512000 },
    { id: "liquid/lfm-2.5-2.6b:free", name: "LiquidAI: LFM2.5-2.6B (free)", contextLength: 65536 },
    { id: "nvidia/nemotron-3.5-lightning:free", name: "NVIDIA: Nemotron 3.5 Lightning (free)", contextLength: 1000000 },
    { id: "thinkingmachines/inkling-small:free", name: "Thinking Machines: Inkling Small (free)", contextLength: 1048576 },
    { id: "poolside/laguna-s-2.1:free", name: "Poolside: Laguna S 2.1 (free)", contextLength: 262144 },
    { id: "thinkingmachines/inkling:free", name: "Thinking Machines: Inkling (free)", contextLength: 1048576 },
    { id: "poolside/laguna-xs-2.1:free", name: "Poolside: Laguna XS 2.1 (free)", contextLength: 262144 },
    { id: "cohere/north-mini-code:free", name: "Cohere: North Mini Code (free)", contextLength: 256000 },
    { id: "z-ai/glm-5.2:free", name: "Z.ai: GLM 5.2 (free)", contextLength: 32768 },
    { id: "nvidia/nemotron-3.5-content-safety:free", name: "NVIDIA: Nemotron 3.5 Content Safety (free)", contextLength: 128000 },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", name: "NVIDIA: Nemotron 3 Ultra (free)", contextLength: 1000000 },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", name: "NVIDIA: Nemotron 3 Nano Omni (free)", contextLength: 256000 },
    { id: "google/gemma-4-26b-a4b-it:free", name: "Google: Gemma 4 26B A4B (free)", contextLength: 262144 },
    { id: "google/gemma-4-31b-it:free", name: "Google: Gemma 4 31B (free)", contextLength: 262144 },
    { id: "nvidia/nemotron-3-super-120b-a12b:free", name: "NVIDIA: Nemotron 3 Super (free)", contextLength: 262144 },
    { id: "openrouter/free", name: "Free Models Router", contextLength: 200000 },
  ],
  passthroughModels: true,
  serviceKinds: ["llm"],
};
