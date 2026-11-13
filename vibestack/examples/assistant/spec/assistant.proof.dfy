// spec/assistant.md, "A payment is submitted exactly when the bill is charged, for its amount, on the biller's own page":
// what a transition outputs is empty or one effect, and the count of a list of one is whether it is a submission.

lemma SubmissionsOfOne(x: Effect)
  ensures submissions([x]) == (if x.Submitted? then 1 else 0)
{
  ProofLib.FoldLeftAppend((n: int, e: Effect) => (if e.Submitted? then (n + 1) else n), 0, [], x);
  assert [] + [x] == [x];
}

lemma choose_ensures(s: Assistant, choice: Choice, by_: Actor)
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysBudgetBounded(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysPaidOnlyReviewed(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysReviewedHasPositiveAmount(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> alwaysChargedOnce(choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepChoicesSpendBudget(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepReplyAnswersWaiting(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepAmountOnlyFromReply(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepPaidOnlyOnGenuine(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepChargedOnlyOnConfirm(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepSubmittedWhenCharged(s, choose(s, choice, by_).state, choose(s, choice, by_).out))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepCardOnlySaved(s, "choose", choose(s, choice, by_).state))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepFilledOnlyGenuine(s, choose(s, choice, by_).state, choose(s, choice, by_).out))
  ensures (inv(s) ==> canChoose(s, choice, by_) ==> stepRequestNeverGoesBack(s, "choose", choose(s, choice, by_).state))
{
  SubmissionsOfOne(Filled(s.page, s.card));
  SubmissionsOfOne(Said("paid"));
  SubmissionsOfOne(Said("working"));
}

lemma confirm_ensures(s: Assistant, by_: Actor)
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysBudgetBounded(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysPaidOnlyReviewed(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysReviewedHasPositiveAmount(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> alwaysChargedOnce(confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepChoicesSpendBudget(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepReplyAnswersWaiting(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepAmountOnlyFromReply(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepPaidOnlyOnGenuine(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepChargedOnlyOnConfirm(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepSubmittedWhenCharged(s, confirm(s, by_).state, confirm(s, by_).out))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepCardOnlySaved(s, "confirm", confirm(s, by_).state))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepFilledOnlyGenuine(s, confirm(s, by_).state, confirm(s, by_).out))
  ensures (inv(s) ==> canConfirm(s, by_) ==> stepRequestNeverGoesBack(s, "confirm", confirm(s, by_).state))
{
  SubmissionsOfOne(Submitted(s.page, s.bill.amount));
}
