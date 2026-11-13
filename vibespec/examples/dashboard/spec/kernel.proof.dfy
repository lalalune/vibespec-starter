// spec/kernel.md, "A new number is above the stored counter and above every number seen"; ProofLib.FoldLeftMax (vibespec/proof/lib.dfy)

lemma lawNextIsAboveTheCounter_ensures(seen: seq<int>, stored: int)
  ensures (lawNextIsAboveTheCounter(seen, stored) == true)
{
  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), stored, seen);
}

lemma lawNextIsAboveEverythingSeen_ensures(seen: seq<int>, stored: int)
  ensures (lawNextIsAboveEverythingSeen(seen, stored) == true)
{
  ProofLib.FoldLeftMax((top: int, x: int) => (if (x > top) then x else top), stored, seen);
}
