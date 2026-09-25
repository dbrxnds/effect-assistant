import { RegistryProvider } from "@effect/atom-react"
import { createRootRoute, Outlet } from "@tanstack/react-router"

function Root() {
  return (
    <RegistryProvider>
      <Outlet />
    </RegistryProvider>
  )
}

export const Route = createRootRoute({ component: Root })
