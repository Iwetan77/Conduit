"use client";

// Running payroll.
//
// Four screens, and the order is the whole design: build it, read it, confirm
// it, then watch it. The thing that makes payroll frightening is finding out
// what you were about to do only after you had done it, so nothing here pays
// anybody until somebody has seen every line.
//
// The confirmation step is the last point a wrong address can be caught by a
// human, which is why it shows resolved names rather than hex and why it is a
// separate screen rather than a checkbox on the preview.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAccount } from "wagmi";
import { useMyAccount } from "@/lib/queries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createPayrollRun,
  discardPayrollRun,
  listEmployeeGroups,
  listEmployees,
  executePayrollRun,
  listPayrollRuns,
  recordPayrollLeg,
  ConduitApiError,
  type PayrollRun,
  type PayrollLeg,
} from "@/lib/conduit-api";
import { isoToToken } from "@/lib/currencies";
import { TokenIcon } from "@/components/Shared/TokenBadge";
import { shortenAddress, formatMinorUnits, parseAmount } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";
import type { Currency } from "@conduit/sdk/lite";
import { useCircleAccount } from "@/lib/circle/connection";

const EXPLORER = process.env.NEXT_PUBLIC_EXPLORER ?? "https://testnet.arcscan.app";

function errorText(err: unknown): string {
  // The real message, whatever kind of error it is.
  //
  // This returned "Something went wrong. Try again." for anything that was not
  // a ConduitApiError -- which is every wallet, provider and signing failure,
  // i.e. most of what can actually go wrong here. A payroll that refused to
  // sign for the business's own address reported itself as "Something went
  // wrong", and that sentence is why it took a person to find the cause
  // instead of the screen saying it.
  if (err instanceof ConduitApiError) return err.message;
  if (err instanceof Error && err.message) return err.message;
  return "Something went wrong. Try again.";
}

type Stage = "idle" | "preview" | "confirm" | "running" | "done";

export default function PayrollPage() {
  const qc = useQueryClient();
  // The wallet actually signed in, not whichever extension is installed.
  // Signing reached for window.ethereum when this was missing, which for a
  // Google merchant is the wrong wallet entirely — see lib/payroll-sign.
  const { connector } = useAccount();
  const { connector: circleConnector } = useCircleAccount();
  const signingConnector = circleConnector ?? connector;
  // The business's address. Salaries leave from here, not from the wallet the
  // owner signed in with -- see lib/settlement-signer.
  const { data: account } = useMyAccount();
  const treasury = account?.settle_address ?? "";
  const [stage, setStage] = useState<Stage>("idle");
  const [run, setRun] = useState<PayrollRun | null>(null);
  const [legs, setLegs] = useState<PayrollLeg[]>([]);
  const [progress, setProgress] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const activeConversion = useRef<AbortController | null>(null);
  useEffect(() => () => activeConversion.current?.abort(), []);

  const { data: history, error: historyError } = useQuery({ queryKey: ["payroll-runs"], queryFn: listPayrollRuns });
  const { data: groupData, isLoading: groupsLoading, error: groupsError } = useQuery({
    queryKey: ["employee-groups"],
    queryFn: listEmployeeGroups,
  });
  const groups = groupData?.data ?? [];
  const { data: employeeData, isLoading: employeesLoading, error: employeesError } = useQuery({
    queryKey: ["employees", false],
    queryFn: () => listEmployees(false),
  });
  const all = (employeeData?.data ?? []).filter((e) => e.status === "active");
  const loadError = employeesError ?? groupsError;
  const rosterLoading = groupsLoading || employeesLoading;
  // Who this run pays. "" is everybody active, which is what a run has always
  // meant and what an account with no groups still gets.
  const [groupID, setGroupID] = useState("");
  const [amountGroup, setAmountGroup] = useState<string | null>(null);
  const [variableAmounts, setVariableAmounts] = useState<Record<string, string>>({});
  const variableEmployees =
    amountGroup === null
      ? []
      : all.filter(
          (employee) =>
            employee.pay_type === "variable" &&
            (amountGroup === "" || employee.group_id === amountGroup),
        );

  const build = async (forGroup: string, enteredAmounts: Record<string, string> = {}) => {
    setError("");
    setBusy(true);
    setGroupID(forGroup);
    try {
      const amounts: Record<string, string> = {};
      for (const [employeeID, displayAmount] of Object.entries(enteredAmounts)) {
        const employee = all.find((candidate) => candidate.id === employeeID);
        if (!employee) throw new Error("An employee in this payroll could not be found.");
        amounts[employeeID] = parseAmount(
          displayAmount,
          isoToToken(employee.pay_currency) as Currency,
        ).toString();
      }
      const draft = await createPayrollRun(amounts, forGroup || undefined);
      setAmountGroup(null);
      setVariableAmounts({});
      setRun(draft);
      setStage("preview");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };
  const chooseScope = (forGroup: string) => {
    setGroupID(forGroup);
    const hasVariablePay = all.some(
      (employee) =>
        employee.pay_type === "variable" &&
        (forGroup === "" || employee.group_id === forGroup),
    );
    if (hasVariablePay) {
      setError("");
      setVariableAmounts({});
      setAmountGroup(forGroup);
      return;
    }
    void build(forGroup);
  };


  const execute = async () => {
    if (!run) return;
    setError("");
    setBusy(true);
    try {
      // A key per attempt, generated once here. The server refuses a second
      const settlementAddress = run.settle_address ?? treasury;
      if (!settlementAddress) {
        throw new Error("This payroll has no settlement wallet to sign from.");
      }

      // execute carrying it, which is what makes a double click, a retry or a
      // restored tab pay nobody twice.
      const runKey = `${run.id}-${crypto.randomUUID()}`;
      const res = await executePayrollRun(run.id, runKey);
      setLegs(res.legs);
      setStage("running");

      // Signing happens per currency group, and each is reported as it
      // resolves rather than all at the end -- groups genuinely land at
      // different times, and collapsing them is what makes "partial"
      // impossible to show.
      const conversionController = new AbortController();
      activeConversion.current = conversionController;
      for (const leg of res.legs) {
        setProgress((p) => ({ ...p, [leg.currency]: "waiting for you to approve…" }));
        try {
          const { payPayrollLeg } = await import("@/lib/payroll-sign");
          // The settlement address the run itself was built against, so the
          // wallet that signs is the wallet the draft costed and checked the
          // balance of. Reading it from anywhere else risks the two disagreeing.
          const txHash = await payPayrollLeg(
            res.spender,
            leg,
            signingConnector,
            settlementAddress,
            // A leg in a currency the treasury does not hold is converted
            // first, in the browser, right before its approve. The merchant
            // presses send once; the conversion is a step, not a chore.
            run.treasury_currency,
            (stage) => setProgress((p) => ({ ...p, [leg.currency]: stage })),
            conversionController.signal,
          );
          await recordPayrollLeg(run.id, { currency: leg.currency, tx_hash: txHash });
          setProgress((p) => ({ ...p, [leg.currency]: "paid" }));
        } catch (err) {
          if (conversionController.signal.aborted && err instanceof DOMException && err.name === "AbortError") return;
          const reason = errorText(err);
          setProgress((p) => ({ ...p, [leg.currency]: `failed — ${reason}` }));
          // Recorded, not swallowed. A group nobody reports stays pending
          // forever, which tells the people in it nothing.
          await recordPayrollLeg(run.id, {
            currency: leg.currency,
            failed: true,
            error: reason,
          }).catch(() => {});
        }
      }

      const final = await createPayrollRunRefresh(run.id);
      setRun(final);
      setStage("done");
      await qc.invalidateQueries({ queryKey: ["payroll-runs"] });
    } catch (err) {
      setError(errorText(err));
      setStage("preview");
    } finally {
      activeConversion.current = null;
      setBusy(false);
    }
  };
  const retryUnpaid = async () => {
    if (!run) return;
    const unpaid = run.items.filter((item) => item.status !== "paid");
    if (unpaid.length === 0) return;

    setError("");
    setBusy(true);
    try {
      const amounts = Object.fromEntries(
        unpaid.map((item) => [item.employee_id, item.amount]),
      );
      const draft = await createPayrollRun(
        amounts,
        undefined,
        unpaid.map((item) => item.employee_id),
      );
      setRun(draft);
      setLegs([]);
      setProgress({});
      setStage("preview");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };


  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="Payroll"
        description="Review the people and amounts before sending each group's payroll."
        action={<Link href="/dashboard/employees" className="text-sm text-signal hover:underline">Employees</Link>}
      />
      {loadError && (
        <p className="text-danger text-sm mb-4">
          {errorText(loadError)}
        </p>
      )}

      {stage === "idle" && (
        // Groups first, as CARDS rather than a dropdown behind a button.
        //
        // This screen used to be one "Run payroll" button with the group
        // hidden in a select underneath it, which got the order backwards: the
        // first decision a merchant makes is WHO is being paid, and a business
        // with three teams should see three teams, not a verb. Picking is the
        // action; the draft follows from it.
        <div className="space-y-4">
          {amountGroup !== null && (
            <VariablePayAmounts
              employees={variableEmployees}
              values={variableAmounts}
              busy={busy}
              error={error}
              onChange={setVariableAmounts}
              onSubmit={() => void build(amountGroup, variableAmounts)}
              onCancel={() => setAmountGroup(null)}
            />
          )}

          {rosterLoading && <p className="text-ink-dim text-xs py-4">Loading groups...</p>}
          {!rosterLoading && !loadError && groups.length === 0 && (
            <div className="border border-border p-8 text-center space-y-2">
              <p className="text-ink text-sm">No employee groups yet.</p>
              <p className="text-ink-dim text-xs">
                Create a group on the Employees page, add its people, then come
                back to pay that group as one batch.
              </p>
              <Link
                href="/dashboard/employees"
                className="inline-block mt-2 border border-signal/40 text-signal text-xs font-mono px-4 py-2 hover:bg-signal/10 transition-colors"
              >
                Go to Employees
              </Link>
            </div>
          )}

          {!rosterLoading && !loadError && groups.length > 0 && (
            <>
              <p className="text-ink-dim text-xs">Who are you paying?</p>

              <div className="grid gap-2 sm:grid-cols-2">
                {groups.map((g) => {
                  const members = all.filter((employee) => employee.group_id === g.id);
                  const assets = [...new Set(members.map((employee) => isoToToken(employee.pay_currency)))];
                  const variableCount = members.filter((employee) => employee.pay_type === "variable").length;
                  return (
                    <button
                      key={g.id}
                      type="button"
                      disabled={busy || amountGroup !== null || members.length === 0}
                      onClick={() => chooseScope(g.id)}
                      className="min-h-[92px] text-left border border-border p-4 transition-colors
                                 hover:border-signal hover:bg-signal/5
                                 disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent"
                    >
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-ink text-sm font-medium break-words">{g.name}</span>
                        <span className="shrink-0 text-signal text-xs font-mono">
                          {members.length > 0 ? "Review" : "Empty"}
                        </span>
                      </span>
                      <span className="block text-ink-dim text-xs mt-1 font-mono">
                        {members.length} active
                        {variableCount > 0 && ` / ${variableCount} variable`}
                      </span>
                      {assets.length > 0 && (
                        <span className="flex flex-wrap items-center gap-2 mt-2">
                          {assets.map((asset) => (
                            <span key={asset} className="inline-flex items-center gap-1 text-xs font-mono text-ink-dim">
                              <TokenIcon currency={asset as Currency} px={14} />{asset}
                            </span>
                          ))}
                        </span>
                      )}
                    </button>
                  );
                })}

              </div>


              {busy && <p className="text-ink-dim text-xs font-mono">Building the draft…</p>}
              {amountGroup === null && error && <p className="text-danger text-xs">{error}</p>}
            </>
          )}
        </div>
      )}

      {run && (stage === "preview" || stage === "confirm") && (
        <Preview
          run={run}
          stage={stage}
          busy={busy}
          error={error}
          onBack={() => {
            if (stage === "confirm") {
              setStage("preview");
              return;
            }
            // Backing out of the preview throws the draft away. Building one to
            // read it is not an event in this business's history, and every
            // abandoned preview used to leave a row behind that Past runs then
            // listed as "draft" forever.
            //
            // Fire-and-forget, and the UI does not wait on it: the person has
            // already decided to leave this screen, and a failed cleanup is not
            // their problem to sit through. The server excludes drafts from the
            // list either way, so the worst case is a tidy-up that did not
            // happen rather than something they can see.
            const id = run.id;
            setStage("idle");
            setRun(null);
            void discardPayrollRun(id).catch(() => {});
          }}
          onContinue={() => setStage("confirm")}
          onConfirm={() => void execute()}
        />
      )}

      {(stage === "running" || stage === "done") && run && (
        <Progress
          run={run}
          legs={legs}
          progress={progress}
          stage={stage}
          busy={busy}
          error={error}
          onRetry={() => void retryUnpaid()}
          onReset={() => {
            setStage("idle");
            setRun(null);
            setLegs([]);
            setProgress({});
          }}
        />
      )}

      {historyError && <p className="mt-6 text-danger text-xs">Past runs could not be loaded.</p>}
      <History runs={history?.data ?? []} />
    </div>
  );
}
type VariablePayEmployee = {
  id: string;
  name: string;
  pay_currency: string;
};

function VariablePayAmounts({
  employees,
  values,
  busy,
  error,
  onChange,
  onSubmit,
  onCancel,
}: {
  employees: VariablePayEmployee[];
  values: Record<string, string>;
  busy: boolean;
  error: string;
  onChange: (values: Record<string, string>) => void;
  onSubmit: () => void;
  onCancel: () => void;
}) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="border border-border p-4 space-y-3"
    >
      <div>
        <p className="text-ink text-sm font-medium">Enter variable pay</p>
        <p className="text-ink-dim text-xs mt-1">
          These amounts apply to this payroll run only.
        </p>
      </div>
      {employees.map((employee) => (
        <label key={employee.id} className="block">
          <span className="flex justify-between text-xs mb-1">
            <span className="text-ink">{employee.name}</span>
            <span className="font-mono text-ink-dim">
              {isoToToken(employee.pay_currency)}
            </span>
          </span>
          <input
            required
            inputMode="decimal"
            value={values[employee.id] ?? ""}
            onChange={(event) =>
              onChange({ ...values, [employee.id]: event.target.value })
            }
            placeholder="0.00"
            className="w-full bg-surface border border-border px-3 py-2 text-sm font-mono focus:border-signal focus:outline-none"
          />
        </label>
      ))}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy}
          className="flex-1 bg-signal text-signal-ink py-2 text-sm font-medium disabled:opacity-50"
        >
          {busy ? "Building draft..." : "Review payroll"}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onCancel}
          className="border border-border px-4 py-2 text-sm text-ink-dim"
        >
          Cancel
        </button>
      </div>
      {error && <p className="text-danger text-xs">{error}</p>}
    </form>
  );
}


// Re-reads the run after execution, so what is shown is what the server
// recorded rather than what the browser believes happened.
async function createPayrollRunRefresh(id: string): Promise<PayrollRun> {
  const { getPayrollRun } = await import("@/lib/conduit-api");
  return getPayrollRun(id);
}

function Preview({
  run,
  stage,
  busy,
  error,
  onBack,
  onContinue,
  onConfirm,
}: {
  run: PayrollRun;
  stage: Stage;
  busy: boolean;
  error: string;
  onBack: () => void;
  onContinue: () => void;
  onConfirm: () => void;
}) {
  const confirming = stage === "confirm";
  const shortfall = run.balance_covers === false;

  return (
    <div className="space-y-4">
      <div className="border border-border">
        <div className="px-4 py-3 border-b border-border flex items-center justify-between">
          <p className="text-ink text-sm font-medium">
            {confirming ? "Confirm — this pays these people" : "Draft payroll"}
          </p>
          <p className="text-ink-dim text-xs font-mono">{run.items.length} people</p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] text-sm">
            <tbody>
              {run.items.map((it) => (
                <tr key={it.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-3 text-ink">{it.name}</td>
                  {/* Resolved name over hex, always. This is the last screen where
                      a wrong line can be caught by a person, and a column of hex
                      is a column nobody reads. */}
                  <td className="px-4 py-3 font-mono text-xs text-ink-dim">
                    {it.username ? `@${it.username}` : shortenAddress(it.address)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-xs">
                    {formatMinorUnits(it.amount, it.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="border border-border p-4 space-y-2">
        {run.groups.map((g) => (
          <div key={g.currency} className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="flex items-center gap-2">
              <TokenIcon currency={isoToToken(g.currency) as Currency} px={18} />
              <span className="font-mono text-xs">{isoToToken(g.currency)}</span>
              {g.needs_conversion && (
                // A step, not a warning.
                //
                // This used to read "needs converting first" beside a button
                // that could not do it -- the conversion was advertised here
                // and unimplemented, so the leg reached a signature, reverted
                // on insufficient balance, and reported a generic wallet
                // error. It is built now (convertForLeg in lib/payroll-sign),
                // runs in the browser immediately before the approve, and the
                // merchant presses send once.
                <span className="text-ink-dim text-xs">
                  converted from {isoToToken(run.treasury_currency)} automatically
                </span>
              )}
            </span>
            <span className="font-mono text-xs text-right">
              {formatMinorUnits(g.total, g.currency)} · {g.recipients} people
            </span>
          </div>
        ))}

        <div className="border-t border-border pt-2 space-y-1">
          {run.estimated_gas && (
            <div className="flex justify-between text-xs text-ink-dim">
              <span>Estimated gas</span>
              {/* Arc charges gas in USDC, so it comes out of the same balance
                  the salaries do. Worth its own line rather than a footnote. */}
              <span className="font-mono">
                {formatMinorUnits(run.estimated_gas, run.treasury_currency)} (paid in {isoToToken(run.treasury_currency)})
              </span>
            </div>
          )}
          {run.wallet_balance && (
            <div className="flex justify-between text-xs">
              <span className="text-ink-dim">Wallet balance</span>
              <span className={`font-mono ${shortfall ? "text-danger" : "text-ink-dim"}`}>
                {formatMinorUnits(run.wallet_balance, run.treasury_currency)}
              </span>
            </div>
          )}
        </div>

        {shortfall && (
          <p className="text-danger text-xs">
            This is more than the wallet holds, so it cannot be run yet. Top up{" "}
            {isoToToken(run.treasury_currency)} in your settlement wallet and
            come back — a payroll that starts short pays the first group, empties
            the wallet, and leaves the rest unpaid.
          </p>
        )}
      </div>

      {error && <p className="text-danger text-xs">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          onClick={onBack}
          className="border border-border px-4 py-2 text-sm text-ink-dim hover:text-ink"
        >
          Back
        </button>
        {/* Refused, not warned about.
            The shortfall used to sit beside a working button, so the only thing
            standing between a business and a half-paid payroll was reading a
            red paragraph. It is not a judgement call the person clicking should
            have to make: there is no amount of willingness that makes the
            wallet cover it, and the run cannot succeed. The server refuses this
            too — this button is the courtesy, that is the rule. */}
        <button
          type="button"
          onClick={confirming ? onConfirm : onContinue}
          disabled={busy || shortfall}
          className="flex-1 bg-signal text-signal-ink font-medium py-2 text-sm disabled:opacity-50"
        >
          {busy
            ? "Paying…"
            : shortfall
              ? "Not enough to run this"
              : confirming
                ? `Pay ${run.items.length} people`
                : "Review and confirm"}
        </button>
      </div>
    </div>
  );
}

function Progress({
  run,
  legs,
  progress,
  stage,
  busy,
  error,
  onRetry,
  onReset,
}: {
  run: PayrollRun;
  legs: PayrollLeg[];
  progress: Record<string, string>;
  stage: Stage;
  busy: boolean;
  error: string;
  onRetry: () => void;
  onReset: () => void;
}) {
  const paid = run.items.filter((i) => i.status === "paid");
  const unpaid = run.items.filter((i) => i.status !== "paid");

  return (
    <div className="space-y-4">
      <div aria-live="polite" className="border border-border p-4 space-y-2">
        {legs.map((leg) => (
          <div key={leg.currency} className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <TokenIcon currency={isoToToken(leg.currency) as Currency} px={18} />
              <span className="font-mono text-xs">{isoToToken(leg.currency)}</span>
            </span>
            <span className="text-xs text-ink-dim font-mono">
              {progress[leg.currency] ?? "waiting"}
            </span>
          </div>
        ))}
      </div>

      {stage === "done" && (
        <div className="border border-border p-4 space-y-3">
          <p className="text-ink text-sm">
            {run.status === "completed"
              ? "Everybody was paid."
              : run.status === "partial"
                ? "Some people were paid and some were not."
                : "Nobody was paid."}
          </p>

          {/* Named, both ways. On a partial run the only useful thing is which
              of these two lists a person is in. */}
          {paid.length > 0 && (
            <div>
              <p className="text-ink-dim text-xs uppercase tracking-wider font-mono mb-1">Paid</p>
              {paid.map((i) => (
                <p key={i.id} className="text-xs flex justify-between">
                  <span className="text-ink">{i.username ? `@${i.username}` : i.name}</span>
                  <span className="font-mono text-ink-dim">
                    {formatMinorUnits(i.amount, i.currency)}
                    {i.tx_hash && (
                      <a
                        href={`${EXPLORER}/tx/${i.tx_hash}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-signal ml-2 hover:underline"
                      >
                        tx
                      </a>
                    )}
                  </span>
                </p>
              ))}
            </div>
          )}

          {unpaid.length > 0 && (
            <div>
              <p className="text-ink-dim text-xs uppercase tracking-wider font-mono mb-1">Not paid</p>
              {unpaid.map((i) => (
                <p key={i.id} className="text-xs flex justify-between">
                  <span className="text-ink">{i.username ? `@${i.username}` : i.name}</span>
                  <span className="font-mono text-danger">{i.error ?? i.status}</span>
                </p>
              ))}
              <p className="text-ink-dim text-xs mt-2">
                Review a new draft containing only the people who were missed.
                Successful payments from this run are excluded.
              </p>
            </div>
          )}

          {error && <p className="text-danger text-xs">{error}</p>}
          <div className="flex gap-2">
            {unpaid.length > 0 && (
              <button
                type="button"
                onClick={onRetry}
                disabled={busy}
                className="flex-1 bg-signal text-signal-ink px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {busy ? "Building retry..." : "Review unpaid payroll"}
              </button>
            )}
            <button
              type="button"
              onClick={onReset}
              disabled={busy}
              className="border border-border px-4 py-2 text-sm text-ink-dim hover:text-ink disabled:opacity-50"
            >
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function History({ runs }: { runs: PayrollRun[] }) {
  if (runs.length === 0) return null;
  return (
    <div className="mt-8">
      <p className="text-ink-dim text-xs uppercase tracking-wider font-mono mb-2">Past runs</p>
      <div className="border border-border">
        {runs.map((r) => (
          <div key={r.id} className="px-4 py-3 border-b border-border last:border-0 flex justify-between text-xs">
            <span className="font-mono text-ink-dim">{new Date(r.created_at).toLocaleDateString()}</span>
            <span
              className={`font-mono ${
                r.status === "completed"
                  ? "text-signal"
                  : r.status === "partial"
                    ? "text-ink"
                    : "text-ink-dim"
              }`}
            >
              {r.status}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
