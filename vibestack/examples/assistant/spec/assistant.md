# Assistant

An assistant that takes a request, works through it one action at a time,
and pays a bill on the person's behalf. The turn is an agent loop: a model
chooses each next action. Paying drives a browser through a biller's site.
The person, the model and the outside world each send their own events.

## Domain

### Who sends an event

The person, the model choosing the agent's actions, and the world: websites
and services answering requests. The program knows who sent each event, so
an event never says it.

```quint
type Actor = Person | Agent | World
```

### A turn

A turn is idle, planning its next action, asking the person, or done. The
model chooses among six actions, and a turn may take at most four.

```quint
type Phase = Idle | Planning | Asking | Done
type Choice = Lookup | Review | Fill | Pay | Speak | Finish
pure val maxActions = 4
```

### The bill and the page

The bill's amount comes from the biller. The browser shows a page that is the
biller's own, a lookalike, or not yet known.

```quint
type Page = Unknown | Genuine | Lookalike
type Bill = { amount: int, reviewed: bool, paid: bool }
```

### What the program carries out

The assistant does not speak or type itself. A choice returns what the
program must carry out beside the new state: a sentence to say, or the saved
card typed into a page.

```quint
type Effect = Said({ text: str }) | Filled({ page: Page, card: SecretCard })
```

### The assistant

What is saved survives a restart: the card, the bill, what was charged, the
last request and the one last answered. The rest is in memory.

```quint
type Assistant = {
  phase: Phase, budget: int, page: Page, waiting: bool,
  card: SecretCard, bill: Bill, charged: int, request: int, answered: int,
}

type Chosen = { state: Assistant, out: List[Effect] }

pure val initial: Assistant = {
  phase: Idle, budget: 0, page: Unknown, waiting: false,
  card: "", bill: { amount: 0, reviewed: false, paid: false }, charged: 0, request: 0, answered: 0,
}
```

## Story: Take a turn

> As a person, I want to ask for help and have the assistant work through it
> one step at a time, and always come back to me.

### Only the person starts a turn, and not while one is under way

A turn can start while the assistant is idle (before the first turn, or after
a restart) or once the last turn is done, not while it is planning or asking.
It starts with the whole budget of four actions.

```quint
pure def canBegin(s: Assistant, by: Actor): bool =
  by == Person and (s.phase == Idle or s.phase == Done)

pure def begin(s: Assistant, by: Actor): Assistant =
  { ...s, phase: Planning, budget: maxActions }
```

### The model chooses each action, and each costs one from the turn

Looking the bill up sends a new request. Reviewing checks an amount that has
arrived. Filling types the saved card, and only into the biller's own page.
Paying asks the person, once the bill is reviewed and not yet paid. Speaking
says whether the bill is paid yet. A choice that cannot be carried out still
costs one. The turn ends when the model finishes, or when the budget runs out
while planning; a choice that asks the person waits for their answer first.

```quint
pure def canChoose(s: Assistant, choice: Choice, by: Actor): bool =
  by == Agent and s.phase == Planning and s.budget > 0

pure def choose(s: Assistant, choice: Choice, by: Actor): Chosen =
  val t = { ...s, budget: s.budget - 1 }
  val chosen =
    if (choice == Lookup) { ...t, request: t.request + 1, waiting: true }
    else if (choice == Review) { ...t, bill: { ...t.bill, reviewed: t.bill.amount > 0 } }
    else if (choice == Pay) (if (t.bill.reviewed and not(t.bill.paid)) { ...t, phase: Asking } else t)
    else if (choice == Finish) { ...t, phase: Done }
    else t
  {
    state: if (chosen.phase == Planning and chosen.budget == 0) { ...chosen, phase: Done } else chosen,
    out:
      if (choice == Fill and t.page == Genuine) List(Filled({ page: t.page, card: t.card }))
      else if (choice == Speak) List(Said({ text: if (t.bill.paid) "paid" else "working" }))
      else List(),
  }
```

### A turn's budget stays within bounds, and a turn being planned has some left

```quint
pure def alwaysBudgetBounded(s: Assistant): bool =
  0 <= s.budget and s.budget <= maxActions and (s.phase == Planning implies s.budget > 0)
```

### Every choice spends the budget

So a turn holds at most four model choices. That planning then ends is the
next rule.

```quint
pure def stepChoicesSpendBudget(before: Assistant, via: str, after: Assistant): bool =
  via == "choose" implies after.budget < before.budget
```

### A turn being planned ends

If the model's choices are not put off for ever, a turn being planned comes
to be asking the person, done, or idle after a restart. Pages loading and
replies arriving cannot hold it in planning. This does not say that the
person answers when asked, or that the biller replies: a turn may wait on
either without end.

```quint
pure def leadsToPlanningEnds(s: Assistant, later: Assistant): bool =
  s.phase == Planning implies later.phase != Planning

pure val fair_choose = "weak"
```

### A turn can end

```quint
pure def sometimesTurnEnds(s: Assistant): bool = s.phase == Done
```

## Story: Look up the bill

> As a person, I want the assistant to fetch my bill from the biller, and
> never to act on an answer that came too late.

### Only the world replies, and only to the request still waiting

A reply to an older request, or one that arrives after the bill is paid, is
refused, and a reply must carry a positive amount. A new amount must be
reviewed again.

```quint
pure def canReply(s: Assistant, request: int, amount: int, by: Actor): bool =
  by == World and s.waiting and request == s.request and amount > 0 and not(s.bill.paid)

pure def reply(s: Assistant, request: int, amount: int, by: Actor): Assistant =
  { ...s, waiting: false, answered: request, bill: { ...s.bill, amount: amount, reviewed: s.bill.reviewed and amount == s.bill.amount } }
```

### A reply answers the request that was waiting

```quint
pure def stepReplyAnswersWaiting(before: Assistant, via: str, after: Assistant): bool =
  via == "reply" implies (before.waiting and after.answered == before.request)
```

### The amount changes only when a reply arrives

```quint
pure def stepAmountOnlyFromReply(before: Assistant, via: str, after: Assistant): bool =
  after.bill.amount != before.bill.amount implies via == "reply"
```

### A bill's amount can arrive

```quint
pure def sometimesAmountArrived(s: Assistant): bool = s.bill.amount > 0
```

## Story: Pay a bill

> As a person, I want a bill paid only after its amount was checked, only on
> the biller's own site, and only once I say yes.

### The world decides which page the browser shows

```quint
pure def canLoad(s: Assistant, by: Actor): bool = by == World

pure def load(s: Assistant, page: Page, by: Actor): Assistant = { ...s, page: page }
```

### Only the person confirms a payment, and only while asked

The person can confirm only on the biller's own page, for a reviewed bill not
yet paid. The turn then goes back to planning, or ends if no budget is left.

```quint
pure def canConfirm(s: Assistant, by: Actor): bool =
  by == Person and s.phase == Asking and s.page == Genuine and s.bill.reviewed and not(s.bill.paid)

pure def confirm(s: Assistant, by: Actor): Assistant =
  { ...s, phase: if (s.budget > 0) Planning else Done, bill: { ...s.bill, paid: true }, charged: s.charged + 1 }
```

### Only the person declines a payment

Declining leaves the bill unpaid. The turn goes back to planning, or ends if
no budget is left.

```quint
pure def canDecline(s: Assistant, by: Actor): bool = by == Person and s.phase == Asking

pure def decline(s: Assistant, by: Actor): Assistant =
  { ...s, phase: if (s.budget > 0) Planning else Done }
```

### A bill is paid only on the biller's own page

```quint
pure def stepPaidOnlyOnGenuine(before: Assistant, via: str, after: Assistant): bool =
  (after.bill.paid and not(before.bill.paid)) implies after.page == Genuine
```

### A paid bill was reviewed

```quint
pure def alwaysPaidOnlyReviewed(s: Assistant): bool = s.bill.paid implies s.bill.reviewed
```

### A reviewed bill has a positive amount

Discovered by the proof: a paid bill with a zero amount otherwise satisfies
the rules, but reviewing it again would erase its reviewed status.

```quint
pure def alwaysReviewedHasPositiveAmount(s: Assistant): bool =
  s.bill.reviewed implies s.bill.amount > 0
```

### A bill is charged once, and only when the person confirms

```quint
pure def alwaysChargedOnce(s: Assistant): bool = s.charged == (if (s.bill.paid) 1 else 0)

pure def stepChargedOnlyOnConfirm(before: Assistant, via: str, after: Assistant): bool =
  after.charged != before.charged implies via == "confirm"
```

### A bill can be paid

```quint
pure def sometimesPaid(s: Assistant): bool = s.bill.paid
```

## Story: Keep my details safe

> As a person, I want my card details typed only into the biller's own site,
> and nothing secret read aloud.

### Card details go only into the biller's own page

```quint
pure def stepFilledOnlyGenuine(before: Assistant, after: Assistant, out: List[Effect]): bool =
  out.every(e => match e { | Filled(f) => f.page == Genuine | _ => true })
```

### Card details can be filled in

The model can choose to fill while the biller's own page is showing.

```quint
pure def sometimesFillable(s: Assistant): bool = s.phase == Planning and s.page == Genuine
```

### Nothing secret is said aloud

The card is secret, so `check` refuses the model if the card, or anything
decided by it, can reach what is said, or any other place that is not secret.

```quint
type SecretCard = str
```

### The model sees nothing secret

What the model is shown to choose its next action: the turn, the page and the
bill. `Seen` has no secret field, so `check` refuses any of its fields that
the card could reach.

```quint
type Seen = { phase: Phase, budget: int, page: Page, waiting: bool, bill: Bill }

pure def seen(s: Assistant): Seen =
  { phase: s.phase, budget: s.budget, page: s.page, waiting: s.waiting, bill: s.bill }
```

## Story: Survive a restart

> As a person, I want a crash in the middle of a task to lose nothing paid or
> promised, and never to pay twice.

### A restart loses what was in memory and keeps what was saved

The request number is saved, so a request after the restart never reuses one
from before it, and a late reply to the old one is refused.

```quint
pure def restart(s: Assistant): Assistant =
  { ...s, phase: Idle, budget: 0, page: Unknown, waiting: false }
```

### A request number never goes back

```quint
pure def stepRequestNeverGoesBack(before: Assistant, via: str, after: Assistant): bool =
  after.request >= before.request
```

### A restart can come after a payment

```quint
pure def sometimesRestartedAfterPaying(s: Assistant): bool = s.phase == Idle and s.bill.paid
```
