# App

What the application in `apps/app` does: it greets a person by name and
counts the greetings.

## Story: Say hello

> As a visitor, I want to type my name and be greeted, so that I know the
> page heard me.

### A greeter holds the last name it greeted and how many greetings it gave

It starts with no name and no greetings.

```quint
type Greeter = { name: str, count: int }

pure val initial: Greeter = { name: "", count: 0 }
```

### Only a name that is not empty can be greeted

Greeting a name remembers it and counts one more greeting.

```quint
pure def canGreet(g: Greeter, name: str): bool = name != ""

pure def greet(g: Greeter, name: str): Greeter = { name: name, count: g.count + 1 }
```

### Once someone has been greeted, the greeter holds a name

```quint
pure def alwaysGreetedHasName(g: Greeter): bool = g.count > 0 implies g.name != ""
```

### Every step adds exactly one greeting

```quint
pure def stepCountsOne(before: Greeter, after: Greeter): bool = after.count == before.count + 1
```

### A greeting is for the name it was given

Whoever the greeter greeted before, a greeting holds the name given to it.

```quint
pure def lawGreetsTheNameGiven(g: Greeter, name: str): bool = greet(g, name).name == name
```

### Someone can be greeted twice

```quint
pure def sometimesGreetedTwice(g: Greeter): bool = g.count >= 2
```
