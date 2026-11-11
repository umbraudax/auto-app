import { fileURLToPath } from "node:url";
import { withWorkflow } from "workflow/next";

export default withWorkflow({
  serverExternalPackages: ["playwright-core", "pg"],
  outputFileTracingIncludes: {
    "/.well-known/workflow/**": ["./node_modules/playwright-core/browsers.json"],
  },
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
});
