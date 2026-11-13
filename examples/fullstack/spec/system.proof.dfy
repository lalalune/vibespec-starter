// Proofs that the network, the server and the two tabs keep the system's
// rules. What each part does to its own rules comes from the laws the server
// and client specs state (and prove) about themselves; what is left is about
// copies of the list: every copy in a tab or on the network is the list as it
// was at its version.

// Taking a message off the network leaves only messages that were on it.
lemma DropFrom(net: seq<Msg>, i: int, rest: seq<Msg>, from: Cut)
  requires forall x :: x in from.out ==> x in net
  requires forall x :: x in rest ==> x in net
  ensures forall x :: x in Std.Collections.Seq.FoldLeft((acc: Cut, m: Msg) => Cut((if (acc.k == i) then acc.out else (acc.out + [m])), (acc.k + 1)), from, rest).out ==> x in net
  decreases |rest|
{
  if |rest| > 0 {
    var f := (acc: Cut, m: Msg) => Cut((if (acc.k == i) then acc.out else (acc.out + [m])), (acc.k + 1));
    assert rest[0] in net;
    assert forall x :: x in rest[1..] ==> x in rest;
    DropFrom(net, i, rest[1..], f(from, rest[0]));
  }
}

lemma DropAtSubset(net: seq<Msg>, i: int)
  ensures forall x :: x in dropAt(net, i) ==> x in net
{
  DropFrom(net, i, net, uncut);
}

// A copy that was the list at its version still is after the history grows.
lemma PastExtends(h: seq<seq<todo_Todo>>, x: seq<todo_Todo>, v: int, t: seq<todo_Todo>)
  requires isPast(h, v, t)
  ensures isPast(h + [x], v, t)
{
  assert pastAt(h + [x], v) == pastAt(h, v);
}

// What the rule says of every message on the network, for one message.
lemma OnTheWire(sys: System, x: Msg)
  requires alwaysEveryCopyIsTheListAtItsVersion(sys)
  requires x in sys.net
  ensures isRequest(x) || isPast(sys.history, x.version, x.todos)
{
  var j :| 0 <= j < |sys.net| && sys.net[j] == x;
}

lemma act_ensures(sys: System, who: string, op: todo_Op)
  ensures (inv(sys) ==> canAct(sys, who, op) ==> alwaysEachPartKeepsItsRules(act(sys, who, op)))
  ensures (inv(sys) ==> canAct(sys, who, op) ==> alwaysNoTabIsAheadOfTheServer(act(sys, who, op)))
  ensures (inv(sys) ==> canAct(sys, who, op) ==> alwaysTheHistoryEndsWithTheCurrentList(act(sys, who, op)))
  ensures (inv(sys) ==> canAct(sys, who, op) ==> alwaysEveryCopyIsTheListAtItsVersion(act(sys, who, op)))
{
  if inv(sys) && canAct(sys, who, op) {
    var after := act(sys, who, op);
    client_lawQueueingKeepsTheRules_ensures(clientOf(sys, who), op);
    forall j | 0 <= j < |after.net|
      ensures isRequest(after.net[j]) || isPast(after.history, after.net[j].version, after.net[j].todos)
    {
      if j < |sys.net| {
        assert after.net[j] == sys.net[j];
        OnTheWire(sys, sys.net[j]);
      }
    }
  }
}

lemma serve_ensures(sys: System, i: int)
  ensures (inv(sys) ==> canServe(sys, i) ==> alwaysEachPartKeepsItsRules(serve(sys, i)))
  ensures (inv(sys) ==> canServe(sys, i) ==> alwaysNoTabIsAheadOfTheServer(serve(sys, i)))
  ensures (inv(sys) ==> canServe(sys, i) ==> alwaysTheHistoryEndsWithTheCurrentList(serve(sys, i)))
  ensures (inv(sys) ==> canServe(sys, i) ==> alwaysEveryCopyIsTheListAtItsVersion(serve(sys, i)))
{
  if inv(sys) && canServe(sys, i) {
    var m := msgAt(sys.net, i);
    var rest := dropAt(sys.net, i);
    DropAtSubset(sys.net, i);
    var after := serve(sys, i);
    assert sys.server.version >= 0;
    if server_answered(sys.server, m.client, m.seq_) {
      assert after == repeatAnswer(m, rest, sys);
      forall j | 0 <= j < |after.net|
        ensures isRequest(after.net[j]) || isPast(after.history, after.net[j].version, after.net[j].todos)
      {
        if j < |rest| { OnTheWire(sys, rest[j]); }
      }
    } else if server_allows(sys.server, m.client, m.seq_, m.op) {
      var s := server_commit(m.client, sys.server, m.seq_, m.op);
      assert after == applyRequest(m, rest, sys);
      server_lawACommitKeepsTheRules_ensures(sys.server, m.client, m.seq_, m.op);
      todo_lawAListIsTheSameAsItself_ensures(s.todos);
      assert pastAt(after.history, s.version) == s.todos;
      PastExtends(sys.history, s.todos, sys.a.seen, sys.a.confirmed);
      PastExtends(sys.history, s.todos, sys.b.seen, sys.b.confirmed);
      forall j | 0 <= j < |after.net|
        ensures isRequest(after.net[j]) || isPast(after.history, after.net[j].version, after.net[j].todos)
      {
        if j < |rest| {
          OnTheWire(sys, rest[j]);
          if !isRequest(rest[j]) { PastExtends(sys.history, s.todos, rest[j].version, rest[j].todos); }
        }
      }
    } else {
      assert after == refuseRequest(m, rest, sys);
      server_lawARefusalKeepsTheRules_ensures(sys.server, m.client, m.seq_, m.op);
      forall j | 0 <= j < |after.net|
        ensures isRequest(after.net[j]) || isPast(after.history, after.net[j].version, after.net[j].todos)
      {
        if j < |rest| { OnTheWire(sys, rest[j]); }
      }
    }
  }
}

lemma deliver_ensures(sys: System, i: int)
  ensures (inv(sys) ==> canDeliver(sys, i) ==> alwaysEachPartKeepsItsRules(deliver(sys, i)))
  ensures (inv(sys) ==> canDeliver(sys, i) ==> alwaysNoTabIsAheadOfTheServer(deliver(sys, i)))
  ensures (inv(sys) ==> canDeliver(sys, i) ==> alwaysTheHistoryEndsWithTheCurrentList(deliver(sys, i)))
  ensures (inv(sys) ==> canDeliver(sys, i) ==> alwaysEveryCopyIsTheListAtItsVersion(deliver(sys, i)))
{
  if inv(sys) && canDeliver(sys, i) {
    var m := msgAt(sys.net, i);
    var c := clientOf(sys, m.client);
    var after := deliver(sys, i);
    assert m == sys.net[i];
    OnTheWire(sys, m);
    DropAtSubset(sys.net, i);
    client_lawAnAnswerKeepsTheRules_ensures(c, m.seq_, m.version, m.todos);
    forall j | 0 <= j < |after.net|
      ensures isRequest(after.net[j]) || isPast(after.history, after.net[j].version, after.net[j].todos)
    {
      OnTheWire(sys, after.net[j]);
    }
  }
}

lemma lose_ensures(sys: System, i: int)
  ensures (inv(sys) ==> canLose(sys, i) ==> alwaysEachPartKeepsItsRules(lose(sys, i)))
  ensures (inv(sys) ==> canLose(sys, i) ==> alwaysNoTabIsAheadOfTheServer(lose(sys, i)))
  ensures (inv(sys) ==> canLose(sys, i) ==> alwaysTheHistoryEndsWithTheCurrentList(lose(sys, i)))
  ensures (inv(sys) ==> canLose(sys, i) ==> alwaysEveryCopyIsTheListAtItsVersion(lose(sys, i)))
{
  if inv(sys) && canLose(sys, i) {
    var after := lose(sys, i);
    DropAtSubset(sys.net, i);
    forall j | 0 <= j < |after.net|
      ensures isRequest(after.net[j]) || isPast(after.history, after.net[j].version, after.net[j].todos)
    {
      OnTheWire(sys, after.net[j]);
    }
  }
}
