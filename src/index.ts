import { startServer } from "./server.js";

startServer().catch((err) => {
  console.error("fetch-mcp error:", err);
  process.exit(1);
});
