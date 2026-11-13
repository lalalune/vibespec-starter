lemma send_ensures(m: Mailer, n: int)
  ensures (inv(m) ==> canSend(m, n) ==> alwaysAtMostThree(send(m, n).state))
  ensures (inv(m) ==> canSend(m, n) ==> stepSavedBeforeSent(m, send(m, n).state, send(m, n).out))
{
  // The fold over [Saved(n), Sent(n)], one element at a time, with the lambda as the generated rule spells it.
  assert isSaved(Saved(n)) && !isSaved(Sent(n));
  var out := send(m, n).out;
  assert out[1..] == [Sent(n)] && out[1..][1..] == [];
  assert Std.Collections.Seq.FoldLeft((seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen))), 0, out)
    == Std.Collections.Seq.FoldLeft((seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen))), ((seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen))))(0, out[0]), out[1..]);
  assert Std.Collections.Seq.FoldLeft((seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen))), 1, out[1..])
    == Std.Collections.Seq.FoldLeft((seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen))), ((seen: int, e: Effect) => (if (seen < 0) then seen else (if isSaved(e) then 1 else (if (seen == 0) then (0 - 1) else seen))))(1, out[1..][0]), out[1..][1..]);
}
