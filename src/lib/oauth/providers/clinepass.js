import { CLINEPASS_CONFIG } from "../constants/oauth.js";
import { createClineOAuthProvider } from "./clineShared.js";

export default createClineOAuthProvider(CLINEPASS_CONFIG, "ClinePass");
