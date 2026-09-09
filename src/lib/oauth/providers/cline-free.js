import { CLINE_FREE_CONFIG } from "../constants/oauth.js";
import { createClineOAuthProvider } from "./clineShared.js";

export default createClineOAuthProvider(CLINE_FREE_CONFIG, "Cline Free");
