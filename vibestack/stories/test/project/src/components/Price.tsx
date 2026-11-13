export interface PriceProps {
  /** In the currency's smallest unit. */
  cents: number;
  currency: "USD" | "EUR";
  strike?: boolean;
}

/** An amount of money. */
export function Price({ cents, currency, strike = false }: PriceProps) {
  const text = `${(cents / 100).toFixed(2)} ${currency}`;
  return strike ? <s>{text}</s> : <span>{text}</span>;
}
