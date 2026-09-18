import { contentService } from "./content-service.js";

try {
  const { editor } = await contentService();
  const { revision } = await editor.publish();
  console.log(`Published content: ${revision}`);
} catch (error) {
  // Never print raw provider errors, credential paths, or Git stderr.
  console.error(error.status === 423 ? error.message : "Content update failed. The previous live map content remains available; check configuration and retry.");
  process.exitCode = 1;
}
