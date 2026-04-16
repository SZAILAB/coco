import { loadLocalEnvFiles } from "./load-local-env.js";
import { startFeishuBots } from "./feishu-runtime.js";

loadLocalEnvFiles();

try {
  await startFeishuBots();
} catch (err) {
  console.error("[feishu] Failed to start bot:", err);
  process.exit(1);
}
