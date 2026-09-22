import { execFileSync } from "node:child_process";
import type { NextConfig } from "next";

/**
 * Build id derived from the reviewed commit, without a new environment variable
 * (spec §3). Inside the image there is no .git (see .dockerignore), so the build
 * falls back to a constant rather than a random value.
 */
function commitBuildId(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return head.length > 0 ? head : "local";
  } catch {
    return "local";
  }
}

const nextConfig: NextConfig = {
  output: "standalone",
  images: { unoptimized: true },
  // Ruling R-I: nothing user-scoped may sit in a shared in-process cache.
  cacheMaxMemorySize: 0,
  generateBuildId: () => commitBuildId(),
};

export default nextConfig;
