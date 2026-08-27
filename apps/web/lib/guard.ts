// Alias the canonical page guard (packages/core owns lifecycle; auth owns sessions)
// so intelligence surfaces redirect anonymous visitors to /login.
export { requirePageUser as requirePageSession } from "@/lib/auth.js";