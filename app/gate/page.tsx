import { GateForm } from "@/components/GateForm";

export default function GatePage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 px-6 py-16">
      <header className="flex flex-col items-center gap-2 text-center">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">The Fourth Official</h1>
        <p className="text-sm text-foreground/70">Rulings from the Laws of the Game</p>
      </header>
      <GateForm />
    </main>
  );
}
