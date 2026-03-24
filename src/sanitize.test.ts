import { describe, expect, it } from "vitest";
import { hasMeaningfulContent, sanitizeOutput, snippet } from "./sanitize.js";

describe("sanitizeOutput", () => {
  it("strips ANSI and drops obvious Codex chrome", () => {
    const raw =
      "\u001b[2m╭────────────────────────╮\u001b[0m\n" +
      "│ >_ OpenAI Codex (v0.112.0) │\n" +
      "model: gpt-5.4 xhigh\n" +
      "directory: ~/repo\n" +
      "Tip: Use /fast\n" +
      "We should add a retry guard.\n" +
      "We should add a retry guard.\n";

    expect(sanitizeOutput(raw)).toBe("We should add a retry guard.");
  });

  it("keeps plain text and normalizes whitespace", () => {
    const raw = "  the first line of output \r\n\r\nthe second line of output  ";
    expect(sanitizeOutput(raw)).toBe("the first line of output\nthe second line of output");
  });

  it("removes inline Claude input chrome from echoed lines", () => {
    const raw =
      "Youaretherevieweragentinatwo-agentcodingdiscussion Critiquetheotheragentproposal ⏵⏵ bypass permissions on (shift+tab to cycle)\n";
    expect(sanitizeOutput(raw)).toBe("Youaretherevieweragentinatwo-agentcodingdiscussion Critiquetheotheragentproposal");
  });

  it("strips Claude TUI noise: title remnants, spinners, status words", () => {
    expect(sanitizeOutput("0;✳ Claude Code\n")).toBe("");
    expect(sanitizeOutput("✢Actioning…\n")).toBe("");
    expect(sanitizeOutput("0;⠂ Review exponential backoff for Node.js CLI\n")).toBe("");
    expect(sanitizeOutput("Frosting…\n")).toBe("");
    expect(sanitizeOutput("❯\n")).toBe("");
    expect(sanitizeOutput("⠂⠄⠈\n")).toBe("");
  });

  it("strips generic status words (single word + ellipsis)", () => {
    expect(sanitizeOutput("Moseying…\n")).toBe("");
    expect(sanitizeOutput("Determining…\n")).toBe("");
    expect(sanitizeOutput("✽Moseying…\n")).toBe("");
    expect(sanitizeOutput("◦•Wng2•\n")).toBe("");
  });

  it("strips trailing status from real content", () => {
    expect(sanitizeOutput("Good proposal overall. ✽Determining…\n")).toBe("Good proposal overall.");
  });

  it("strips Codex status lines", () => {
    expect(sanitizeOutput("Working(0s • esc to interrupt)\n")).toBe("");
    expect(sanitizeOutput("•Working(0s • esc to interrupt)›Implement {fe\n")).toBe("");
    expect(sanitizeOutput("Pouncing...\n")).toBe("");
    expect(sanitizeOutput("Indexing files\n")).toBe("");
  });

  it("keeps real content that happens to be near noise", () => {
    const raw = "0;⠂ title noise\nThe retry should use exponential backoff.\n✢Actioning…\n";
    expect(sanitizeOutput(raw)).toBe("The retry should use exponential backoff.");
  });
});

describe("hasMeaningfulContent", () => {
  it("returns false for spinner/title/status noise", () => {
    expect(hasMeaningfulContent("0;✳ Claude Code")).toBe(false);
    expect(hasMeaningfulContent("✢Actioning…")).toBe(false);
    expect(hasMeaningfulContent("\u001b[2mt\u001b[0m")).toBe(false); // single char after ANSI strip
    expect(hasMeaningfulContent("co")).toBe(false);
    expect(hasMeaningfulContent("·Ai")).toBe(false);
    expect(hasMeaningfulContent("⠂⠄⠈⠐")).toBe(false);
  });

  it("returns true for real assistant output", () => {
    expect(hasMeaningfulContent("The retry should use exponential backoff.")).toBe(true);
    expect(hasMeaningfulContent("Ship the patch.\n")).toBe(true);
  });
});

describe("snippet", () => {
  it("normalizes case and whitespace", () => {
    expect(snippet("  Hello   WORLD  ")).toBe("hello world");
  });
});
