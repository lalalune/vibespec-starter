// "No task is both open and done", for each transition. A set is a sequence without repeats, and the rule is a
// filter of one by the other: Disjoint says it of members, and the *Filter lemmas restate each transition with
// ProofLib.Filter (AGENTS.md, "Proof files").

lemma OpenOrDoneFilter(l: Tasks)
  ensures alwaysOpenOrDone(l) == (|ProofLib.Filter((set_x: string) => (set_x in l.done), l.open)| == 0)
{
}

lemma Disjoint(l: Tasks)
  ensures alwaysOpenOrDone(l) <==> (forall x: string :: x in l.open ==> x !in l.done)
{
  OpenOrDoneFilter(l);
  ProofLib.FilterNone((set_x: string) => (set_x in l.done), l.open);
}

lemma AddFilter(l: Tasks, title: string)
  ensures add(l, title) == l.(open := (l.open + ProofLib.Filter((set_x: string) => !((set_x in l.open)), [title])))
{
}

lemma CompleteFilter(l: Tasks, title: string)
  ensures complete(l, title) == Tasks(ProofLib.Filter((set_x: string) => !((set_x in [title])), l.open), (l.done + ProofLib.Filter((set_x: string) => !((set_x in l.done)), [title])))
{
}

lemma RemoveFilter(l: Tasks, title: string)
  ensures remove(l, title) == Tasks(ProofLib.Filter((set_x: string) => !((set_x in [title])), l.open), ProofLib.Filter((set_x: string) => !((set_x in [title])), l.done))
{
}

lemma add_ensures(l: Tasks, title: string)
  ensures (inv(l) ==> canAdd(l, title) ==> alwaysOpenWithinLimit(add(l, title)))
  ensures (inv(l) ==> canAdd(l, title) ==> alwaysOpenOrDone(add(l, title)))
{
  if inv(l) && canAdd(l, title) {
    AddFilter(l, title);
    ProofLib.FilterSubset((set_x: string) => !((set_x in l.open)), [title]);
    Disjoint(l);
    Disjoint(add(l, title));
  }
}

lemma complete_ensures(l: Tasks, title: string)
  ensures (inv(l) ==> canComplete(l, title) ==> alwaysOpenWithinLimit(complete(l, title)))
  ensures (inv(l) ==> canComplete(l, title) ==> alwaysOpenOrDone(complete(l, title)))
{
  if inv(l) && canComplete(l, title) {
    CompleteFilter(l, title);
    ProofLib.FilterSubset((set_x: string) => !((set_x in [title])), l.open);
    ProofLib.FilterMember((set_x: string) => !((set_x in [title])), l.open, title);
    ProofLib.FilterSubset((set_x: string) => !((set_x in l.done)), [title]);
    Disjoint(l);
    Disjoint(complete(l, title));
  }
}

lemma remove_ensures(l: Tasks, title: string)
  ensures (inv(l) ==> canRemove(l, title) ==> alwaysOpenWithinLimit(remove(l, title)))
  ensures (inv(l) ==> canRemove(l, title) ==> alwaysOpenOrDone(remove(l, title)))
{
  if inv(l) && canRemove(l, title) {
    RemoveFilter(l, title);
    ProofLib.FilterSubset((set_x: string) => !((set_x in [title])), l.open);
    ProofLib.FilterSubset((set_x: string) => !((set_x in [title])), l.done);
    Disjoint(l);
    Disjoint(remove(l, title));
  }
}
