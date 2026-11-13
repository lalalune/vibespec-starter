// Proofs of the laws of std/net.md about `take`, by induction over its fold.

// Folding the rest of the network into what was kept so far keeps only copies from either.
lemma TakeFrom(i: int, from: Cut, rest: seq<int>)
  ensures forall x :: x in Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), from, rest).kept ==> x in from.kept || x in rest
  ensures |Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), from, rest).kept| == |from.kept| + |rest| - (if from.k <= i < from.k + |rest| then 1 else 0)
  decreases |rest|
{
  if |rest| > 0 {
    var f := (c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1));
    TakeFrom(i, f(from, rest[0]), rest[1..]);
    assert forall x :: x in rest[1..] ==> x in rest;
  }
}

lemma lawTakingStaysBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawTakingStaysBelow(flight, i, n) == true)
{
  TakeFrom(i, Cut([], 0), flight);
  if below(flight, n) {
    forall x | x in flight ensures 0 <= x < n {
      var j :| 0 <= j < |flight| && flight[j] == x;
    }
    var t := take(flight, i);
    assert t == Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), Cut([], 0), flight).kept;
    forall j | 0 <= j < |t| ensures 0 <= t[j] < n {
      assert t[j] in t;
      assert t[j] in flight;
    }
  }
}

lemma lawTakingRemovesOne_ensures(flight: seq<int>, i: int)
  ensures (lawTakingRemovesOne(flight, i) == true)
{
  TakeFrom(i, Cut([], 0), flight);
}
