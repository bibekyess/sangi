import { UserButton } from "@clerk/nextjs"

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "@/components/ui/sidebar"

export function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader />
      <SidebarContent>
        <SidebarGroup />
        <SidebarGroup />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            {/* Clerk renders its own <button>, so the menu button is a div
                shell that mirrors the trigger's focus and open state. Clerk
                mounts into an unstyled div, stretch it so the trigger covers
                the whole menu button. */}
            <SidebarMenuButton
              render={<div />}
              className="p-0 *:data-clerk-component:size-full has-focus-visible:ring-2 has-aria-expanded:bg-sidebar-accent has-aria-expanded:text-sidebar-accent-foreground"
            >
              <UserButton
                showName
                appearance={{
                  elements: {
                    rootBox: "flex size-full",
                    userButtonTrigger:
                      "size-full justify-start rounded-md m-1! text-inherit shadow-none outline-hidden hover:bg-transparent focus:shadow-none",
                    userButtonBox: "w-full min-w-0 justify-start gap-2",
                    userButtonAvatarBox: "order-first size-6 shrink-0",
                    userButtonOuterIdentifier:
                      "truncate ps-0 text-sm font-normal text-inherit",
                  },
                }}
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  )
}
