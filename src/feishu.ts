import { startFeishuBot } from "./feishu-runtime.js";

try {
  await startFeishuBot();
} catch (err) {
  console.error("[feishu] Failed to start bot:", err);
  process.exit(1);
}
