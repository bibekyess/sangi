import Image from "next/image"
import { Avatar, Style } from "@dicebear/core"
import definition from "@dicebear/styles/gaze.json" with { type: "json" }

import { cn } from "@/lib/utils"

const gaze = new Style(definition)

function ChatAvatar({
  seed,
  animated = false,
  className,
}: {
  seed: string
  animated?: boolean
  className?: string
}) {
  const src = new Avatar(gaze, {
    seed,
    tags: animated ? ["animation"] : [],
  }).toDataUri()

  return (
    <Image
      src={src}
      alt=""
      width={32}
      height={32}
      unoptimized
      className={cn("size-8 shrink-0 rounded-full", className)}
    />
  )
}

export { ChatAvatar }
