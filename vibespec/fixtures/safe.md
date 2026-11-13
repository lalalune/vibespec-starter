# Safe

## Story: Open a safe

### A safe opens after its three-number code, and a wrong number starts it again

Random simulation does not find the code among a thousand numbers at each
step; Apalache, which checks every run of up to three events, does.

```quint
pure val initial: int = 0
pure val keyValues = 0.to(999)
pure val exhaustiveSteps = 3

pure def press(opened: int, key: int): int = if (opened < 3 and key == 7 * opened + 3) opened + 1 else 0

pure def alwaysAtMostOpen(opened: int): bool = 0 <= opened and opened <= 3
```
