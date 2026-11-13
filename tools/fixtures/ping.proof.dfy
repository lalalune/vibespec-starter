// Taking a copy off the network keeps only the question in flight (std/net.md, "Only messages that were sent are in flight").
lemma lose_ensures(p: Ping, i: int)
  ensures (inv(p) ==> canLose(p, i) ==> alwaysOnlyTheQuestionIsInFlight(lose(p, i)))
{
  net_lawTakingStaysBelow_ensures(p.net, i, p.sent);
}

lemma deliver_ensures(p: Ping, i: int)
  ensures (inv(p) ==> canDeliver(p, i) ==> alwaysOnlyTheQuestionIsInFlight(deliver(p, i)))
{
  net_lawTakingStaysBelow_ensures(p.net, i, p.sent);
}
