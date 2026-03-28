import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";

const DEFAULT_ENV_FILENAMES = [".env", ".env.local"] as const;

export function loadLocalEnvFiles(
  cwd = process.cwd(),
  filenames: readonly string[] = DEFAULT_ENV_FILENAMES,
): string[] {
  const originalKeys = new Set(Object.keys(process.env));
  const mergedEntries: Record<string, string> = {};
  const loadedPaths: string[] = [];

  for (const filename of filenames) {
    const filePath = path.join(cwd, filename);
    if (!existsSync(filePath)) continue;

    Object.assign(mergedEntries, parseEnv(readFileSync(filePath, "utf8")));
    loadedPaths.push(filePath);
  }

  for (const [key, value] of Object.entries(mergedEntries)) {
    if (originalKeys.has(key)) continue;
    process.env[key] = value;
  }

  return loadedPaths;
}
