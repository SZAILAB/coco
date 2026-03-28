import { loadLocalEnvFiles } from "./load-local-env.js";
import { startFeishuBot } from "./feishu-runtime.js";

loadLocalEnvFiles();

try {
  await startFeishuBot();
} catch (err) {
  console.error("[feishu] Failed to start bot:", err);
  process.exit(1);
}
