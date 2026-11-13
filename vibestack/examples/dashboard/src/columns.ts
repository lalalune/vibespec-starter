//@ backend dafny
// Hand-written because Quint has no loops; `npm run check` proves its contracts.

/** 26 to the power k. */
//@ pure
export function power26(k: number): number {
  //@ requires k >= 0
  //@ decreases k
  return k === 0 ? 1 : 26 * power26(k - 1);
}

/** The number base-26 digits stand for, reading digit d as d + 1: [0] is 1, [0, 0] is 27. */
//@ pure
export function digitsValue(digits: number[]): number {
  //@ decreases digits.length
  return digits.length === 0 ? 0 : (digits[0] + 1) * power26(digits.length - 1) + digitsValue(digits.slice(1));
}

/** A column as base-26 digits, most significant first: 0 is [0] (A), 26 is [0, 0] (AA). */
export function columnDigits(col: number): number[] {
  //@ requires col >= 0
  //@ ensures \result.length >= 1
  //@ ensures forall(k, 0 <= k && k < \result.length ==> 0 <= \result[k] && \result[k] < 26)
  //@ ensures digitsValue(\result) === col + 1
  let digits: number[] = [];
  let n = col + 1;
  while (n > 0) {
    //@ invariant n >= 0
    //@ invariant n == 0 ==> digits.length >= 1
    //@ invariant forall(k, 0 <= k && k < digits.length ==> 0 <= digits[k] && digits[k] < 26)
    //@ invariant digitsValue(digits) + n * power26(digits.length) === col + 1
    //@ decreases n
    const d = (n - 1) % 26;
    digits = [d].concat(digits);
    n = Math.floor((n - 1) / 26);
  }
  return digits;
}

/** The letters a person sees: 0 is "A", 27 is "AB". */
export function columnName(col: number): string {
  //@ requires col >= 0
  return columnDigits(col).map((d) => String.fromCharCode(65 + d)).join("");
}
