import * as Lark from "@larksuiteoapi/node-sdk";
import { describe, expect, it } from "vitest";
import {
  createFeishuProxyAgent,
  extractInboundMessage,
  parseFeishuMessageText,
  readFeishuProxy,
  resolveFeishuDomain,
} from "./feishu-runtime.js";

describe("feishu runtime", () => {
  it("parses text message content", () => {
    expect(parseFeishuMessageText('{"text":"hello"}', "text")).toBe("hello");
  });

  it("parses post message content into plain text", () => {
    const content = JSON.stringify({
      zh_cn: {
        content: [
          [
            { tag: "text", text: "hello" },
            { tag: "text", text: "world" },
          ],
        ],
      },
    });

    expect(parseFeishuMessageText(content, "post")).toContain("hello");
    expect(parseFeishuMessageText(content, "post")).toContain("world");
  });

  it("extracts inbound text messages and deduplicates by message id", () => {
    const recent = new Map<string, number>();
    const event = {
      sender: {
        sender_id: { open_id: "ou_123" },
        sender_type: "user",
      },
      message: {
        message_id: "om_123",
        chat_id: "oc_123",
        message_type: "text",
        content: '{"text":"/coco help"}',
      },
    };

    expect(extractInboundMessage(event, recent, 1000)).toEqual({
      messageId: "om_123",
      chatId: "oc_123",
      userId: "ou_123",
      text: "/coco help",
    });
    expect(extractInboundMessage(event, recent, 1001)).toBeNull();
  });

  it("ignores bot messages", () => {
    const event = {
      sender: {
        sender_id: { open_id: "ou_bot" },
        sender_type: "bot",
      },
      message: {
        message_id: "om_123",
        chat_id: "oc_123",
        message_type: "text",
        content: '{"text":"hello"}',
      },
    };

    expect(extractInboundMessage(event)).toBeNull();
  });

  it("maps feishu and lark domains", () => {
    expect(resolveFeishuDomain("feishu")).toBe(Lark.Domain.Feishu);
    expect(resolveFeishuDomain("lark")).toBe(Lark.Domain.Lark);
    expect(resolveFeishuDomain("https://custom.example")).toBe("https://custom.example");
  });

  it("prefers explicit feishu proxy env", () => {
    expect(
      readFeishuProxy({
        COCO_FEISHU_PROXY: "http://explicit-proxy:7890",
        HTTPS_PROXY: "http://https-proxy:8080",
      }),
    ).toBe("http://explicit-proxy:7890");
  });

  it("falls back to standard proxy envs", () => {
    expect(
      readFeishuProxy({
        HTTPS_PROXY: " http://https-proxy:8080 ",
      }),
    ).toBe("http://https-proxy:8080");
    expect(
      readFeishuProxy({
        http_proxy: "http://lowercase-proxy:8080",
      }),
    ).toBe("http://lowercase-proxy:8080");
  });

  it("creates a websocket proxy agent when proxy is configured", () => {
    expect(createFeishuProxyAgent(null)).toBeNull();
    expect(createFeishuProxyAgent("http://127.0.0.1:7890")).toBeTruthy();
  });
});
