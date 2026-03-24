import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform === "win32") {
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const helperPath = path.join(
  __dirname,
  "..",
  "node_modules",
  "node-pty",
  "prebuilds",
  `${process.platform}-${process.arch}`,
  "spawn-helper",
);

if (!fs.existsSync(helperPath)) {
  console.log(`[coco] node-pty spawn-helper not found at ${helperPath}, skipping`);
  process.exit(0);
}

const stat = fs.statSync(helperPath);
if ((stat.mode & 0o111) !== 0) {
  console.log(`[coco] node-pty spawn-helper already executable`);
  process.exit(0);
}

fs.chmodSync(helperPath, 0o755);
console.log(`[coco] fixed node-pty spawn-helper permissions: ${helperPath}`);
