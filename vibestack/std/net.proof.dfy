lemma TakeBelow(xs: seq<int>, i: int, c: Cut, n: int)
  requires below(xs, n) && below(c.kept, n)
  ensures below(Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), c, xs).kept, n)
  decreases |xs|
{
  if |xs| > 0 {
    var f := (c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1));
    assert xs[0] in xs;
    assert forall x :: x in xs[1..] ==> x in xs;
    assert below(f(c, xs[0]).kept, n);
    TakeBelow(xs[1..], i, f(c, xs[0]), n);
  }
}

lemma TakeLength(xs: seq<int>, i: int, c: Cut)
  ensures |Std.Collections.Seq.FoldLeft((c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1)), c, xs).kept| == |c.kept| + |xs| - (if c.k <= i < c.k + |xs| then 1 else 0)
  decreases |xs|
{
  if |xs| > 0 {
    var f := (c: Cut, id: int) => Cut((if (c.k == i) then c.kept else (c.kept + [id])), (c.k + 1));
    TakeLength(xs[1..], i, f(c, xs[0]));
  }
}

lemma lawTakingStaysBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawTakingStaysBelow(flight, i, n) == true)
{
  if below(flight, n) { TakeBelow(flight, i, Cut([], 0), n); }
}

lemma lawTakingRemovesOne_ensures(flight: seq<int>, i: int)
  ensures (lawTakingRemovesOne(flight, i) == true)
{
  TakeLength(flight, i, Cut([], 0));
}

lemma lawRepeatingStaysBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawRepeatingStaysBelow(flight, i, n) == true)
{
  if below(flight, n) && has(flight, i) { assert flight[i] in flight; }
}

lemma lawWhatIsAtAPositionIsBelow_ensures(flight: seq<int>, i: int, n: int)
  ensures (lawWhatIsAtAPositionIsBelow(flight, i, n) == true)
{
  if below(flight, n) && has(flight, i) { assert flight[i] in flight; }
}
