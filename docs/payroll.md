# Payroll

Paying a list of people, once, in one transaction per currency.

## Employees

The people you pay regularly. Add somebody by `@username` and Conduit resolves it
to the address that account settles to; a raw address works too, for people who
have no Conduit account.

The username is resolved **once**, when you add them, and the address is stored.
Names are for reading and addresses are for paying — if the name were resolved at
pay time instead, a name that changed hands between hiring somebody and paying
them would send their salary to whoever holds it now.

A username names a **person**, and resolves to that person's own address. It is
never a business's: somebody who runs a company holds their handle on their own
account, and the company is addressed by its name and its settlement address.
`@ivan` is Ivan; "Ivan and Sons" is the company; they are different things with
different addresses. So paying an employee by username pays the employee, even
when that employee is also somebody's boss.

Two arrangements:

- **Fixed** — the same amount every run. It must have an amount.
- **Variable** — you enter the amount each run. It must not have one stored; an
  amount sitting against somebody paid a different sum monthly is a number that
  will eventually be paid by accident.

Nobody is ever deleted. **Pause** takes somebody out of the next run and keeps
their history; **archive** is the end state. A deleted row would break the record
of every run that paid them — the run would still say what it paid, and the
person it paid would be a dangling reference.

Editing cannot change an address. Where somebody is paid is not a detail of their
record, and changing it quietly on a row a payroll run reads is how money goes
elsewhere with nobody looking. Archive them and add them again.

## A run

Four steps, and the order is the design: build, read, confirm, watch.

**Draft.** Built from everybody active. Fixed employees bring their amount;
variable ones take one you supply. Nothing is paid, and nothing is committed to
except the amounts — which are **frozen at this moment**. A raise afterwards
cannot change what this run says it paid.

The draft carries the whole preview: every line, totals per currency, which
currencies need converting, the estimated gas, and your wallet balance against
it. "You cannot afford this" belongs here, not at the signature.

A draft you do not run is **discarded**, not kept. Building one to read the
number is a question, not an event in the business's history, so it does not
appear in past runs and backing out of the preview throws it away.

**A run you cannot afford is refused, not warned about.** If the settlement
wallet holds less than the total plus gas, execution is rejected
(`payroll_insufficient_balance`) before anything is signed. This was a red
paragraph beside a working button, which is the wrong shape for it: there is no
amount of willingness that makes the wallet cover the run, and starting one short
pays the first currency group, empties the wallet, and leaves the rest unpaid.
The check reads the chain, so if the balance cannot be read at all the run is
allowed — a flaky node must not become an outage for the one operation with a
deadline attached.

**Confirm.** A separate screen listing every recipient by name. It is the last
point at which a wrong line can be caught by a person, which is why it shows
resolved names rather than hex.

**Execute.** The server claims the run and hands back one leg per currency. Your
wallet signs each: one approve for the group's total, then one `disperse`.

**Watch.** Each group is reported as it resolves.

## Gas is in USDC

Arc charges gas in USDC rather than a separate native token, so your treasury
needs USDC on top of what you are paying out. The preview says how much.

## Which wallet signs

The **business's settlement wallet** — the one its income lands in, not the
wallet its owner signed in with. Those are two different addresses, and the
signature has to come from the one that holds the money.

## What "atomic" means here, and what it does not

**Within one currency, a run is all-or-nothing.** The contract pulls the total
once and pays everybody in the same call. If any transfer fails — a blocked
address, a short allowance — the whole thing reverts and nobody in that group is
paid. Half a payroll is worse than none: the people paid have been, the people
not paid cannot be told when they will be, and nothing records which is which.

**Across currencies, it is not.** Employees choose the currency they are paid in;
a business holds one. Anything else has to be converted first, through StableFX,
whose quotes expire in about three and a half seconds. Pretending a mixed-currency
run is one atomic event would be a lie about what can be guaranteed.

So a run can end **partial**: one currency group paid, another not. That is a
first-class outcome and not an error. The run says exactly who was paid, who was
not, and why. Running payroll again pays only the people who were missed.

## Paying twice

You cannot. Each execution carries a run key, and the database refuses a second
one — not a check in the application, a unique constraint, because two requests
arriving together would both pass a check.

A double-clicked button, a retried request and a browser restoring a tab all
produce a second execute. None of them can be prevented in a browser, which is
why the refusal is where every attempt is seen.

## The contract

`ConduitPayroll` is one function and holds nothing between calls. No owner, no
admin, no upgradeability, no fees, no pause — it never has a balance to rescue,
and each of those features would be a key somebody holds over your payroll.

Two things it will not do:

- **Fee-on-transfer tokens are refused**, not absorbed. Such a token delivers less
  than was pulled, so the payments would run out near the end of the list. The
  contract cannot know whose salary should cover a fee.
- **Duplicate recipients are paid twice, deliberately.** One address appearing
  twice is a person with two arrangements — salary and expenses. Collapsing them
  would pay one and drop the other.

Deployed on Arc testnet at `0xcC4b99a2B74DA98695d4136FB7F20988621BeB11`.

## Events

`payroll.run.completed`, `payroll.run.partial`, `payroll.run.failed` — each
carrying the run id, its status, and how many lines paid and failed. See
[webhooks](webhooks.md).

## Not in this version

**Scheduling.** Recurring runs are a real feature and a separate one; a manual
run has to be right first. Every run here is started by a person.
