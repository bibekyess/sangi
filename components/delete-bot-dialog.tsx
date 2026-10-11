"use client"

import * as React from "react"

import { deleteBot } from "@/actions/bot"
import type { Bot } from "@/db/schema"
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"

function DeleteBotDialog({
  bot,
  children,
  onDeleted,
}: {
  bot: Bot
  children: React.ReactElement
  onDeleted?: () => void
}) {
  const [open, setOpen] = React.useState(false)
  const [isPending, startTransition] = React.useTransition()

  function onConfirm() {
    startTransition(async () => {
      const result = await deleteBot(bot.id)
      if (!result.success) {
        toast.add({
          title: "Couldn't delete bot",
          description: result.error,
          type: "error",
        })
        return
      }

      toast.add({ title: `${bot.name} is deleted`, type: "success" })
      setOpen(false)
      onDeleted?.()
    })
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={children} />
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {bot.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Its direct chat and messages go with it. This can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={isPending}
            onClick={onConfirm}
          >
            {isPending && <Spinner data-icon="inline-start" />}
            Delete
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

export { DeleteBotDialog }
