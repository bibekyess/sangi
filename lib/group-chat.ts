// Addressed in a group chat in place of a bot. Auto answers no message
// itself: it hands each one to the bots whose jobs fit, one at a time
export const AUTO_BOT_ID = "auto"

export const AUTO_BOT_NAME = "Auto"

type Mentionable = { id: string; name: string }

// Who a group chat message is addressed to: the @Names it opens with, and the
// text after them. Mentions later on only talk about a bot. Names can hold
// spaces and are unique per user case-insensitively, so the longest name that
// fits wins. A name ends at a space, comma or colon, so "@Coder" isn't read as
// "@Code", and "@Code.js" or "@Writer's" isn't a mention
export function splitLeadingMentions(text: string, bots: Mentionable[]) {
  const candidates = [{ id: AUTO_BOT_ID, name: AUTO_BOT_NAME }, ...bots].sort(
    (a, b) => b.name.length - a.name.length
  )
  const botIds: string[] = []
  let rest = text
  for (;;) {
    // "@Coder, @Writer: fix it" opens with both
    const start = rest.match(/^[\s,:]*/)?.[0].length ?? 0
    if (rest[start] !== "@") {
      break
    }
    const at = start + 1
    const bot = candidates.find(
      (candidate) =>
        rest.slice(at, at + candidate.name.length).toLowerCase() ===
          candidate.name.toLowerCase() &&
        /^(?:[\s,:]|$)/.test(rest.slice(at + candidate.name.length))
    )
    if (!bot) {
      break
    }
    if (!botIds.includes(bot.id)) {
      botIds.push(bot.id)
    }
    rest = rest.slice(at + bot.name.length)
  }
  return {
    botIds,
    rest: botIds.length > 0 ? rest.replace(/^[\s,:]+/, "") : text,
  }
}

// Who answers a message: the one bot it opens by addressing, or Auto when it
// addresses several, to work out between them. Undefined when it addresses none
export function addressedBotId(text: string, bots: Mentionable[]) {
  const { botIds } = splitLeadingMentions(text, bots)
  if (botIds.length === 0) {
    return undefined
  }
  return botIds.length === 1 ? botIds[0] : AUTO_BOT_ID
}

// Who a message goes to: the bot it addresses, or else the one last addressed.
// The composer previews it and sending follows it, so they can't disagree
export function recipientBotId(
  text: string,
  bots: Mentionable[],
  lastBotId: string
) {
  return addressedBotId(text, bots) ?? lastBotId
}
