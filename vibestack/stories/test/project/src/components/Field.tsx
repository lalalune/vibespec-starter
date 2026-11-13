import { useState } from "react";

export interface FieldProps {
  label: string;
  error?: string;
  disabled?: boolean;
  onChange?: (value: string) => void;
}

/** A labelled text field. */
export function Field({ label, error, disabled, onChange }: FieldProps) {
  const [value, setValue] = useState("");
  return (
    <label>
      {label}
      <input value={value} disabled={disabled} aria-invalid={!!error} onChange={(e) => { setValue(e.target.value); onChange?.(e.target.value); }} />
      {error && <em role="alert">{error}</em>}
    </label>
  );
}
