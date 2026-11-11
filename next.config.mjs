import { fileURLToPath } from "node:url";
import { withWorkflow } from "workflow/next";

export default withWorkflow({
  serverExternalPackages: ["playwright-core", "pg"],
  turbopack: { root: fileURLToPath(new URL(".", import.meta.url)) },
});
