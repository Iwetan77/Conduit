"use client";

// The people this business pays.
//
// Adding somebody by @username is the primary path and the form says so: the
// name field is first and the address field is the alternative, not the other
// way round. That ordering is the product's position, not a layout preference —
// a typed address is unrecoverable when wrong and looks identical when right,
// and this is a list that gets paid every month without anyone re-reading it.
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  addEmployee,
  archiveEmployee,
  listEmployees,
  updateEmployee,
  ConduitApiError,
  type Employee,
} from "@/lib/conduit-api";
import { isoToToken } from "@/lib/currencies";
import { SettleCurrencySelect } from "@/components/Shared/SettleCurrencySelect";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { shortenAddress, formatMinorUnits } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";
import { UserMark } from "@/components/Shared/UserMark";
import { currencyDecimals, type Currency } from "@conduit/sdk/lite";

const qkEmployees = ["employees"] as const;

function toMinorUnits(human: string, decimals: number): string {
  const clean = human.replace(/[^0-9.]/g, "");
  const [whole = "0", frac = ""] = clean.split(".");
  const padded = frac.padEnd(decimals, "0").slice(0, decimals);
  return (BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(padded || "0")).toString();
}

function errorText(err: unknown): string {
  return err instanceof ConduitApiError ? err.message : "Something went wrong. Try again.";
}

export default function EmployeesPage() {
  const qc = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: [...qkEmployees, showArchived],
    queryFn: () => listEmployees(showArchived),
  });
  const employees = data?.data ?? [];
  const refresh = () => qc.invalidateQueries({ queryKey: qkEmployees });

  return (
    <div className="max-w-4xl mx-auto">
      <PageHeader
        title="Employees"
        description="The people this business pays. Add them by username so nobody has to check a hex address."
      />

      <AddEmployee onAdded={refresh} />

      <div className="mt-6 border border-border">
        {isLoading && <p className="text-ink-dim text-xs p-4">Loading…</p>}

        {!isLoading && employees.length === 0 && (
          // Says what the page is for. "No employees" tells somebody who has
          // never used it nothing at all.
          <div className="p-8 text-center space-y-1">
            <p className="text-ink text-sm">Nobody on the payroll yet.</p>
            <p className="text-ink-dim text-xs">
              Add the people you pay regularly, then run payroll to pay them all
              in one transaction.
            </p>
          </div>
        )}

        {employees.length > 0 && (
          <table className="w-full text-sm">
            <thead className="text-left text-ink-dim border-b border-border">
              <tr>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Paid to</th>
                <th className="px-4 py-3 font-medium">Receives</th>
                <th className="px-4 py-3 font-medium text-right">Amount</th>
                <th className="px-4 py-3 font-medium">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {employees.map((e) => (
                <EmployeeRow key={e.id} employee={e} onChanged={refresh} />
              ))}
            </tbody>
          </table>
        )}
      </div>

      <button
        type="button"
        onClick={() => setShowArchived((v) => !v)}
        className="mt-3 text-ink-dim text-xs font-mono hover:text-ink"
      >
        {showArchived ? "Hide archived" : "Show archived"}
      </button>
    </div>
  );
}

function EmployeeRow({ employee, onChanged }: { employee: Employee; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const token = isoToToken(employee.pay_currency);

  const run = async (fn: () => Promise<unknown>) => {
    setError("");
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <tr className="border-b border-border last:border-0">
      <td className="px-4 py-3 text-ink">{employee.name}</td>
      <td className="px-4 py-3 font-mono text-xs">
        {/* The name, when there is one. A hex address on a payroll line is the
            thing nobody checks, and a name is what makes a wrong line visible. */}
        {employee.username ? (
          <span className="text-ink">@{employee.username}</span>
        ) : (
          <span className="text-ink-dim" title={employee.address}>
            {shortenAddress(employee.address)}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <span className="flex items-center gap-1.5">
          <TokenIcon currency={token as Currency} px={16} />
          <span className="font-mono text-xs">{token}</span>
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs">
        {employee.pay_type === "fixed" && employee.amount
          ? formatMinorUnits(employee.amount, employee.pay_currency)
          : // Not an empty cell. A variable employee HAS no fixed amount, and
            // a blank reads as missing data rather than as the arrangement.
            <span className="text-ink-dim">Variable</span>}
      </td>
      <td className="px-4 py-3">
        <span
          className={`text-xs font-mono ${
            employee.status === "active"
              ? "text-signal"
              : employee.status === "paused"
                ? "text-ink-dim"
                : "text-ink-dim/60"
          }`}
        >
          {employee.status}
        </span>
      </td>
      <td className="px-4 py-3 text-right whitespace-nowrap">
        {employee.status !== "archived" && (
          <>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(() =>
                  updateEmployee(employee.id, {
                    status: employee.status === "paused" ? "active" : "paused",
                  }),
                )
              }
              className="text-ink-dim text-xs font-mono hover:text-ink mr-3"
            >
              {employee.status === "paused" ? "Resume" : "Pause"}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(() => archiveEmployee(employee.id))}
              className="text-ink-dim text-xs font-mono hover:text-danger"
            >
              Archive
            </button>
          </>
        )}
        {employee.status === "archived" && (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(() => updateEmployee(employee.id, { status: "active" }))}
            className="text-ink-dim text-xs font-mono hover:text-ink"
          >
            Restore
          </button>
        )}
        {error && <p className="text-danger text-xs mt-1">{error}</p>}
      </td>
    </tr>
  );
}

function AddEmployee({ onAdded }: { onAdded: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [byAddress, setByAddress] = useState(false);
  const [username, setUsername] = useState("");
  const [address, setAddress] = useState("");
  const [currency, setCurrency] = useState("USD");
  const [payType, setPayType] = useState<"fixed" | "variable">("fixed");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await addEmployee({
        name: name.trim(),
        username: byAddress ? undefined : username.trim().replace(/^@/, ""),
        address: byAddress ? address.trim() : undefined,
        pay_currency: currency,
        pay_type: payType,
        amount:
          payType === "fixed"
            ? toMinorUnits(amount, currencyDecimals(isoToToken(currency) as Currency))
            : undefined,
      });
      setName("");
      setUsername("");
      setAddress("");
      setAmount("");
      setOpen(false);
      onAdded();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="border border-border px-4 py-2 text-sm text-ink-dim hover:text-ink hover:border-ink-dim transition-colors"
      >
        Add someone
      </button>
    );
  }

  return (
    <form onSubmit={submit} className="border border-border bg-surface p-6 space-y-3">
      <div>
        <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Name</label>
        <input
          className="w-full bg-bg border border-border px-3 py-2 text-sm focus:border-signal focus:outline-none"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
      </div>

      {/* How this person is identified. Username first, address as the
          alternative -- a typed address is the thing this product spent its
          whole design removing, so it is offered second and with the warning it
          deserves.

          The switch between them is a segmented control, the same one this form
          already uses for Pay. It used to be a line of dim grey text under the
          field, at the size of a footnote, in a colour meant for captions --
          the only route to the second half of this form and you could barely
          see it. A control that changes what the form asks for is not a
          footnote. */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider">
            Identify by
          </label>
        </div>
        <div className="flex gap-2 mb-2">
          {([false, true] as const).map((v) => (
            <button
              type="button"
              key={String(v)}
              onClick={() => setByAddress(v)}
              aria-pressed={byAddress === v}
              className={`flex-1 text-xs px-2 py-2 border transition-colors ${
                byAddress === v
                  ? "border-signal text-signal bg-signal/5"
                  : "border-border text-ink-dim hover:text-ink hover:border-ink-dim"
              }`}
            >
              {v ? "Wallet address" : "Conduit username"}
            </button>
          ))}
        </div>
        {byAddress ? (
          <>
            <input
              className="w-full bg-bg border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
              placeholder="0x..."
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              spellCheck={false}
              required
            />
            <p className="text-ink-dim text-xs mt-1">
              We cannot check this. Payments are on-chain and final, so an
              address that is wrong is money that does not come back.
            </p>
          </>
        ) : (
          <>
            {/* The namespace is furniture, not text -- the same field the
                person on the other end claimed their name in
                (Shared/UsernamePrompt), so it reads the same way on both sides
                of the transaction.

                Every Conduit handle ends identically, so asking the merchant to
                type it is asking them to retype a constant on every employee,
                into the one field that decides who gets paid. It sits inside
                the border and outside the input, so it can never be typed,
                selected, or submitted as part of the name, and it is
                aria-hidden because a screen reader announcing a decoration on
                every keystroke is worse than silence.

                A leading @ is stripped on the way in, so somebody who types the
                handle out of habit is not told they are wrong. */}
            <div className="w-full bg-bg border border-border flex items-center px-3 py-2 transition-colors focus-within:border-signal">
              <UserMark username={username.trim() || null} size="sm" />
              <input
                className="flex-1 min-w-0 ml-2.5 bg-transparent text-sm font-mono text-ink outline-none placeholder:text-ink-dim/50"
                placeholder="theirname"
                value={username}
                onChange={(e) => setUsername(e.target.value.replace(/^@/, ""))}
                maxLength={20}
                spellCheck={false}
                autoComplete="off"
                autoCapitalize="none"
                aria-label="Their Conduit username"
                required
              />
              <span aria-hidden className="shrink-0 text-sm font-mono text-ink-dim/60 select-none">
                @ conduit
              </span>
            </div>
          </>
        )}
      </div>

      <div className="flex gap-2">
        <div className="flex-1">
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Receives</label>
          <SettleCurrencySelect value={currency} onChange={setCurrency} />
        </div>
        <div className="flex-1">
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Pay</label>
          <div className="flex gap-2">
            {(["fixed", "variable"] as const).map((t) => (
              <button
                type="button"
                key={t}
                onClick={() => setPayType(t)}
                className={`flex-1 text-xs px-2 py-2 border ${
                  payType === t ? "border-signal text-signal" : "border-border text-ink-dim"
                }`}
              >
                {t === "fixed" ? "Same each run" : "Varies"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {payType === "fixed" && (
        <div>
          <label className="text-scale-1 font-mono text-ink-dim uppercase tracking-wider block mb-1">Amount</label>
          <input
            className="w-full bg-bg border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
            placeholder="0.00"
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </div>
      )}
      {payType === "variable" && (
        <p className="text-ink-dim text-xs">
          You will enter their amount each time you run payroll.
        </p>
      )}

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
        >
          {busy ? "Adding…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="border border-border px-4 text-sm text-ink-dim hover:text-ink"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
