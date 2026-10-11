import "server-only"

import { createOpenAICompatible } from "@ai-sdk/openai-compatible"

// Any OpenAI-compatible server, configured with FREELLM_* variables:
//   FREELLM_API      full endpoint, e.g. https://host/v1/chat/completions
//   FREELLM_API_KEY  sent as "Authorization: Bearer <key>"
//   FREELLM_MODEL    model ID passed to the server, e.g. "auto"
//   FREELLM_HEADERS  optional extra headers, "Name: value" separated by
//                    newlines or semicolons, e.g. "HTTP-Referer: dummy-service"

function requireEnv(name: string) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`Missing environment variable ${name}`)
  }
  return value
}

// The SDK appends /chat/completions itself, so accept either form
function toBaseURL(endpoint: string) {
  return endpoint.replace(/\/+$/, "").replace(/\/chat\/completions$/, "")
}

function parseHeaders(value: string | undefined) {
  const headers: Record<string, string> = {}
  for (const line of value?.split(/[\n;]/) ?? []) {
    const separator = line.indexOf(":")
    if (separator === -1) {
      continue
    }
    const name = line.slice(0, separator).trim()
    const headerValue = line.slice(separator + 1).trim()
    if (name) {
      headers[name] = headerValue
    }
  }
  return headers
}

function createFreeLLM() {
  return createOpenAICompatible({
    name: "freellm",
    baseURL: toBaseURL(requireEnv("FREELLM_API")),
    apiKey: process.env.FREELLM_API_KEY?.trim() || undefined,
    headers: parseHeaders(process.env.FREELLM_HEADERS),
    includeUsage: true,
    // Send screenshots from tools as image parts instead of stringified JSON
    supportsMultiPartToolContent: true,
  })
}

let freellm: ReturnType<typeof createFreeLLM> | undefined

// Built on first use so a missing variable fails the request, not the build
export function getChatModel(modelId = requireEnv("FREELLM_MODEL")) {
  freellm ??= createFreeLLM()
  return freellm.chatModel(modelId)
}
