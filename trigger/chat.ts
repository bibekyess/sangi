import { chat } from "@trigger.dev/sdk/ai"

import { getChatModel } from "@/lib/ai"

// One long-lived run per chat. History is kept by the platform's default
// transcript storage, keyed by chatId, and read back by loadChatTranscript
export const chatAgent = chat.agent({
  id: "chat",
  // streamText comes from the run argument so the managed options apply
  run: async ({ messages, signal, streamText }) =>
    streamText({
      model: getChatModel(),
      messages,
      abortSignal: signal,
    }),
})
