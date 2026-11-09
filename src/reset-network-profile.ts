export type ResetNetworkProfile = { cookies?: string; userAgent?: string };

let networkProfile: ResetNetworkProfile | undefined;

// Optional Cloudflare clearance profile: cookies captured from a grok.com
// browser session (at minimum cf_clearance) plus the user-agent that solved
// the challenge. Cloudflare binds the clearance to the user-agent and IP, and
// pi runs on the same machine as the browser, so only the user-agent must match.
//
// The profile lives apart from resets.ts so the config refresh at session start
// can record it without loading the banked-reset RPC graph.
export function setGrokResetNetworkProfile(profile: ResetNetworkProfile | undefined): void {
  networkProfile = profile?.cookies || profile?.userAgent ? profile : undefined;
}

export function grokResetNetworkProfile(): ResetNetworkProfile | undefined {
  return networkProfile;
}
