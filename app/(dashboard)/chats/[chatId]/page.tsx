export default async function Page(props: PageProps<"/chats/[chatId]">) {
  const { chatId } = await props.params

  return <p>{chatId}</p>
}
