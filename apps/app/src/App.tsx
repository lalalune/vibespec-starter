import { EmptyState } from "@repo/ui";

/** The page every story of spec/app/index.md is shown on; none is written yet. */
export function App() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md items-center justify-center p-6">
      <EmptyState title="Nothing here yet" />
    </main>
  );
}
