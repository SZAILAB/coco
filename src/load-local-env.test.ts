import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadLocalEnvFiles } from "./load-local-env.js";

const TEST_KEYS = ["COCO_TEST_BASE", "COCO_TEST_LOCAL", "COCO_TEST_SHARED"] as const;

describe("loadLocalEnvFiles", () => {
  afterEach(() => {
    for (const key of TEST_KEYS) {
      delete process.env[key];
    }
  });

  it("loads .env files and keeps process env precedence", () => {
    const tmpDir = mkdtempSync(path.join(os.tmpdir(), "coco-env-"));

    try {
      writeFileSync(
        path.join(tmpDir, ".env"),
        ["COCO_TEST_BASE=from-dotenv", "COCO_TEST_SHARED=from-dotenv"].join("\n"),
      );
      writeFileSync(
        path.join(tmpDir, ".env.local"),
        ["COCO_TEST_LOCAL=from-local", "COCO_TEST_SHARED=from-local"].join("\n"),
      );
      process.env.COCO_TEST_SHARED = "from-process";

      expect(loadLocalEnvFiles(tmpDir)).toEqual([
        path.join(tmpDir, ".env"),
        path.join(tmpDir, ".env.local"),
      ]);
      expect(process.env.COCO_TEST_BASE).toBe("from-dotenv");
      expect(process.env.COCO_TEST_LOCAL).toBe("from-local");
      expect(process.env.COCO_TEST_SHARED).toBe("from-process");
    } finally {
      rmSync(tmpDir, { force: true, recursive: true });
    }
  });
});
