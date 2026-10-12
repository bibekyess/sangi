import "server-only"

import {
  readUIMessageStream,
  stepCountIs,
  streamText,
  tool,
  type InferUITools,
  type UIMessage,
} from "ai"
import { z } from "zod"

import type { Bot } from "@/db/schema"
import {
  getChatModel,
  MAX_AGENT_STEPS,
  streamErrorText,
  thinkingOptions,
} from "@/lib/ai"
import { buildBotPrompt } from "@/lib/bot-prompt"
import {
  createSandboxTools,
  pruneScreenshots,
  type SandboxTools,
} from "@/lib/sandbox-tools"

// The reply of the bot a message was handed to, streamed into the handoff's
// tool call as it builds up. The bot can't hand off again, so its message
// only ever holds sandbox tools
export type HandoffReply = {
  botId: string
  message: UIMessage<never, Record<never, never>, InferUITools<SandboxTools>>
}

function replyText({ message }: HandoffReply) {
  return message.parts
    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
    .filter(Boolean)
    .join("\n\n")
}

// Hands the person's message to another bot of the group, which runs here, in
// this turn, as itself: its own prompt, sandbox and tools, with the
// conversation so far and the brief. `from` is who hands off: a bot, or Auto
export function createHandoffTool({
  chatId,
  from,
  members,
  targets,
  description,
}: {
  chatId: string
  from: string
  // Every bot in the chat, for the prompt of the one handed to
  members: Bot[]
  // The bots this one can hand to
  targets: Bot[]
  description: string
}) {
  const names = targets.map((bot) => bot.name)

  return tool({
    description,
    inputSchema: z.object({
      bot: z
        .enum(names as [string, ...string[]])
        .describe("Name of the bot to hand to"),
      brief: z
        .string()
        .describe(
          "What you need from the bot, and anything it needs to know that isn't already in the conversation"
        ),
    }),
    // A generator, so each step of the bot's reply shows as it happens
    async *execute({ bot: name, brief }, { messages, abortSignal }) {
      const bot = targets.find((target) => target.name === name)
      if (!bot) {
        throw new Error(`There's no bot called ${name} in this chat.`)
      }

      const result = streamText({
        model: getChatModel(),
        instructions: buildBotPrompt(bot, {
          mates: members.filter((member) => member.id !== bot.id),
          handedOffBy: from,
        }),
        // What the caller saw, without its own reply so far, then the brief
        messages: [
          ...messages,
          {
            role: "user",
            content: `<handoff from="${from}">\n${brief}\n</handoff>`,
          },
        ],
        tools: createSandboxTools({ chatId, sandboxId: bot.sandboxId }),
        abortSignal,
        stopWhen: stepCountIs(MAX_AGENT_STEPS),
        // Carries forward, so each step only has to prune the newest images
        prepareStep: ({ messages }) => ({
          messages: pruneScreenshots(messages),
        }),
        ...thinkingOptions,
      })

      const stream = result.toUIMessageStream<HandoffReply["message"]>({
        sendReasoning: true,
        onError: (error) => {
          console.error("Handoff stream error", error)
          return streamErrorText(error)
        },
      })
      // A failed reply fails the tool call, so the caller hears about it
      for await (const message of readUIMessageStream<HandoffReply["message"]>({
        stream,
        terminateOnError: true,
      })) {
        yield { botId: bot.id, message } satisfies HandoffReply
      }
    },
    // The caller and later turns get the reply's text, not every step it took
    toModelOutput: ({ input, output }) => {
      const text = replyText(output)
      return {
        type: "text",
        value: text
          ? `${input.bot} replied to the person:\n\n${text}`
          : `${input.bot} finished without writing a reply.`,
      }
    },
  })
}

export type HandoffTools = {
  handoff: ReturnType<typeof createHandoffTool>
}
