import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // There is a pnpm-workspace.yaml in the home directory; without this Next
  // walks up and tries to root the project at ~, which pulls in everything.
  turbopack: {
    root: path.resolve(__dirname),
  },
  serverExternalPackages: ["@prisma/client", "@prisma/adapter-pg"],
};

export default nextConfig;
