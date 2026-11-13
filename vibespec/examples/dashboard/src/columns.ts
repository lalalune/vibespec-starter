//@ backend dafny
export function columnDigits(col: number): number[] {
  //@ requires col >= 0
  //@ ensures \result.length >= 1
  //@ ensures forall(k, 0 <= k && k < \result.length ==> 0 <= \result[k] && \result[k] < 26)
  let digits: number[] = [];
  let n = col + 1;
  while (n > 0) {
    //@ invariant n >= 0
    //@ invariant n == 0 ==> digits.length >= 1
    //@ invariant forall(k, 0 <= k && k < digits.length ==> 0 <= digits[k] && digits[k] < 26)
    //@ decreases n
    const d = (n - 1) % 26;
    digits = [d].concat(digits);
    n = Math.floor((n - 1) / 26);
  }
  return digits;
}

export function columnName(col: number): string {
  //@ requires col >= 0
  return columnDigits(col).map((d) => String.fromCharCode(65 + d)).join("");
}
