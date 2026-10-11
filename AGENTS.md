<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->


## Git

- Never create branches, worktrees or commits automatically. Only do so when the user explicitly asks for that specific action in the current request.
- Leave changes uncommited in the working tree on the current branch and let the user decide when and how to commit.

## Browser

- Never use Claude in Chrome (`mcp__claude-in-chrome__*` tools) unless the user explicitly asks for it in the current request. Verify changes with typechecking and code review instead, and let the user check the UI.

## Database

- Apply schema changes only with `npm run db:push` (`drizzle-kit push`). Never use migrations: do not run `drizzle-kit generate` or `drizzle-kit migrate`, and do not create or commit a migrations folder.
- This is a development project. There is no backwards compatibility and the data is worthless. Prefer data loss: never backfill, migrate or preserve existing rows, and never spend effort on keeping the old database working. Every schema change means a clean state.

## Forms

Every form follows one pipeline: Drizzle table → zod schema → server action → react-hook-form client. `components/bot-dialog.tsx` + `actions/bot.ts` are the reference implementation.

Stack: `zod` 4, `drizzle-zod`, `react-hook-form`, `@hookform/resolvers` pinned to `~5.2.2` (newer versions pull an optional `@typeschema` peer that conflicts with zod 4). Never install with `--legacy-peer-deps` or `--force`.

### Schema

- Derive the validation schema from the table with `createInsertSchema` from `drizzle-zod`, next to the table in `db/schema.ts`. Never hand-write a zod schema that duplicates a table.
- Refine columns with callbacks that add `.trim()`, limits and user-facing messages, then `.pick()` only the fields a user edits. Never include `id`, `userId`, timestamps or other server-owned columns.
- Export the type as `z.infer<typeof insertXSchema>` and use it on both client and server.
- `db/schema.ts` is imported by client components, so keep it free of `server-only` imports. Database access stays in `db/index.ts`.

### Server action

- One file per entity in `actions/<entity>.ts` with `"use server"` at the top.
- Start every action with `const { isAuthenticated, userId } = await auth()` from `@clerk/nextjs/server`. Take `userId` from the session only, never from the client input.
- Re-validate the input with `schema.safeParse()`. Server actions are public endpoints, so client validation is not enough.
- Return a discriminated union, `{ success: true, ... } | { success: false, error: string }`, rather than throwing for expected failures. Call `revalidatePath` (or `refresh`/`updateTag`, see the Next docs) after the write.

### Client component

- `useForm<T>({ resolver: zodResolver(schema), defaultValues })`, with one `Controller` per field.
- Lay out fields with shadcn `FieldGroup` > `Field` > `FieldLabel` + control + `FieldError`. Put `data-invalid={fieldState.invalid}` on `Field` and `aria-invalid={fieldState.invalid}` on the control.
- Nullable columns need `value={field.value ?? ""}` on the control.
- Every button inside a `<form>` that does not submit needs `type="button"`.
- Show pending state with `disabled={form.formState.isSubmitting}` and a `Spinner` with `data-icon="inline-start"`. Button has no loading prop.
- Report results with `toast.add({ title, description, type })` from `@/components/ui/toast` (Base UI, not sonner). On success, `form.reset()` with fresh defaults.
- Generate client-side defaults such as seeds (`nanoid()`) in a factory function so each reset gets a new value.

### Forms in dialogs

- The dialog owns its trigger: accept `children: React.ReactElement` and render `<DialogTrigger render={children} />`, so a server component page can wrap its button.
- Control `open` with state so the dialog can close itself after a successful submit.
- Give the `<form>` an `id` and put the submit button in `DialogFooter` with `form="<id>"`. Render Cancel as `<DialogClose render={<Button variant="outline" />}>`.

## DiceBear

Use DiceBear 10. Documentation: https://www.dicebear.com/llms.txt

There are seven native cores with identical output, not one library with
wrappers. Use the one matching this project's language. Do not reach for the
JavaScript core when the project is written in something else:

    JavaScript  @dicebear/core + @dicebear/styles
    PHP         dicebear/core + dicebear/styles
    Python      dicebear-core + dicebear-styles
    Rust        dicebear-core + dicebear-styles
    Go          github.com/dicebear/dicebear-go/v10 + github.com/dicebear/styles/v10
    Dart        dicebear_core + dicebear_styles
    C#          DiceBear.Core + DiceBear.Styles

Every style page carries a loading snippet for all seven, for example
https://www.dicebear.com/styles/lorelei/index.md

HTTP API: https://api.dicebear.com/10.x/<style>/svg?seed=<seed> The seed is a
query parameter, not a path segment. Options are query parameters too; array
values are separated by commas.

Options named after a component end in Variant: eyesVariant, not eyes. This
holds in all seven cores and in the HTTP API. Look up the options of a style at
https://api.dicebear.com/10.x/<style>/options.json

Write these forms, not the ones on the left. The left column is pre-10 and the
API does not reject it, so an outdated call runs and silently does the wrong
thing:

    avatars.dicebear.com/api/<style>/<seed>.svg  ->  api.dicebear.com/10.x/<style>/svg?seed=<seed>
    api.dicebear.com/9.x/<style>/svg             ->  api.dicebear.com/10.x/<style>/svg
    npm install @dicebear/collection             ->  npm install @dicebear/styles
    npm install @dicebear/lorelei                ->  npm install @dicebear/styles
    createAvatar(lorelei, { seed })              ->  new Avatar(new Style(definition), { seed })
    { eyes: ['variant01'] }                      ->  { eyesVariant: ['variant01'] }
    ?radius=50                                   ->  ?borderRadius=50

Only JavaScript and the HTTP API have a pre-10 form. The other six cores were
released in 2026 and never had one, so any older-looking PHP, Python, Rust, Go,
Dart or C# API attributed to DiceBear is invented rather than outdated.

