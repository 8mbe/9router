export const AUTO_COMBO_MODEL_FAMILIES = [
  { tokens: ["claude", "opus"], excludedTokens: ["sonnet", "haiku"] },
];

export const AUTO_COMBO_STATUS = {
  WORKING: "working",
  NOT_WORKING: "not_working",
  UNTESTED: "untested",
};

export const AUTO_COMBO_STATUS_RANK = {
  [AUTO_COMBO_STATUS.WORKING]: 0,
  [AUTO_COMBO_STATUS.UNTESTED]: 1,
  [AUTO_COMBO_STATUS.NOT_WORKING]: 2,
};

export const AUTO_COMBO_COOLDOWN_LADDER_MS = [
  2 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  2 * 60 * 60 * 1000,
  6 * 60 * 60 * 1000,
];

export const AUTO_COMBO_HEALTH_TTL_MS = 24 * 60 * 60 * 1000;

export const AUTO_COMBO_STREAM_ERROR_TYPES = new Set(["error", "response.failed"]);
export const AUTO_COMBO_STREAM_FRAME_LIMIT = 256 * 1024;
