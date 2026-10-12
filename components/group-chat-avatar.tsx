import { ChatAvatar } from "@/components/chat-avatar"
import { cn } from "@/lib/utils"

// Where each face sits in the square, by how many are shown. Percentages of
// the avatar's size, so it takes the same room as a single ChatAvatar
const layouts = [
  [],
  ["inset-0"],
  // Side by side, overlapping on the diagonal
  ["top-0 left-0 size-[62.5%]", "right-0 bottom-0 size-[62.5%]"],
  // A triangle
  [
    "top-0 left-1/4 size-1/2",
    "bottom-0 left-0 size-1/2",
    "right-0 bottom-0 size-1/2",
  ],
  // A 2x2 grid, the last cell holding the count
  [
    "top-0 left-0 size-1/2",
    "top-0 right-0 size-1/2",
    "bottom-0 left-0 size-1/2",
    "right-0 bottom-0 size-1/2",
  ],
]

// Up to three bots' faces, then a count of the rest in the fourth cell
function GroupChatAvatar({
  seeds,
  className,
}: {
  seeds: string[]
  className?: string
}) {
  const shown = seeds.slice(0, 3)
  const rest = seeds.length - shown.length
  const cells = layouts[shown.length + (rest > 0 ? 1 : 0)]

  return (
    // A container, so the count's text scales with the avatar
    <div
      aria-hidden
      className={cn("@container relative size-8 shrink-0", className)}
    >
      {shown.map((seed, i) => (
        <ChatAvatar
          key={i}
          seed={seed}
          className={cn("absolute size-full", cells[i])}
        />
      ))}
      {rest > 0 && (
        <span
          className={cn(
            "absolute flex items-center justify-center rounded-full bg-muted text-[length:22cqw] leading-none font-medium text-muted-foreground",
            cells[3]
          )}
        >
          +{rest}
        </span>
      )}
    </div>
  )
}

export { GroupChatAvatar }
