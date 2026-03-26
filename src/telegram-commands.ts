import { buildCocoHelpText, buildDirectSessionEntryText } from "./coco-commands.js";

export type TelegramCommandContext = {
  from?: { id?: number };
  reply(text: string): Promise<unknown> | unknown;
};

export type TelegramNext = () => Promise<unknown> | unknown;

export type TelegramCommandRuntime = {
  allowedUserIds: number[];
};

export function createTelegramCommandHandlers(runtime: TelegramCommandRuntime) {
  return {
    authGuard: async (ctx: TelegramCommandContext, next: TelegramNext) => {
      const userId = ctx.from?.id;
      if (!isAllowedUserId(runtime.allowedUserIds, userId)) {
        await ctx.reply("Not authorized.");
        return;
      }
      await next();
    },

    help: async (ctx: TelegramCommandContext) => {
      await ctx.reply(buildDirectSessionEntryText());
    },
  };
}

export function buildHelpText(): string {
  return [
    "coco telegram commands:",
    "/coco help - Direct session commands",
    "/help - This message",
    "",
    buildCocoHelpText(),
  ].join("\n");
}

function isAllowedUserId(allowedUserIds: number[], userId: number | undefined): boolean {
  return allowedUserIds.length === 0 || (!!userId && allowedUserIds.includes(userId));
}
