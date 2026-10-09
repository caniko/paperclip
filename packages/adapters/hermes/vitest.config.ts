import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "@paperclipai/hermes-paperclip-adapter",
    environment: "node",
    exclude: ["dist/**", "node_modules/**"],
  },
});
