export function Chip({ text, on = false }: { text: string; on?: boolean }) {
  return <b aria-pressed={on}>{text}</b>;
}
