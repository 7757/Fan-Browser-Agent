import { QueryClient } from '@tanstack/react-query'

// Shared React Query client. Lives in its own module (not main.tsx) so non-React
// code can invalidate cached settings without importing the app entry point.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 60_000
    }
  }
})
