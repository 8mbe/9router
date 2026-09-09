import { CLINE_CONFIG } from "../constants/oauth.js";
import { createClineOAuthProvider } from "./clineShared.js";

export default createClineOAuthProvider(CLINE_CONFIG, "Cline");
