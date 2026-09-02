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
import { useState } from "react";
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
import { shortenAddress, formatMinorUnits } from "@/lib/format";
import { PageHeader } from "@/components/Dashboard/PageHeader";
import type { Currency } from "@conduit/sdk/lite";

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

  const { data: history } = useQuery({ queryKey: ["payroll-runs"], queryFn: listPayrollRuns });
  const { data: groupData } = useQuery({
    queryKey: ["employee-groups"],
    queryFn: listEmployeeGroups,
  });
  const groups = groupData?.data ?? [];
  // Only to say how many "Everyone" means. The draft itself is built by the
  // server from the same rule, so this number is a label rather than a source
  // of truth -- it must never be what decides who gets paid.
  const { data: employeeData } = useQuery({
    queryKey: ["employees", false],
    queryFn: () => listEmployees(false),
  });
  const all = (employeeData?.data ?? []).filter((e) => e.status === "active");
  // Who this run pays. "" is everybody active, which is what a run has always
  // meant and what an account with no groups still gets.
  const [groupID, setGroupID] = useState("");
  const chosen = groups.find((g) => g.id === groupID);

  const build = async (forGroup: string) => {
    setError("");
    setBusy(true);
    setGroupID(forGroup);
    try {
      const draft = await createPayrollRun(undefined, forGroup || undefined);
      setRun(draft);
      setStage("preview");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const execute = async () => {
    if (!run) return;
    setError("");
    setBusy(true);
    try {
      // A key per attempt, generated once here. The server refuses a second
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
            connector,
            treasury,
            // A leg in a currency the treasury does not hold is converted
            // first, in the browser, right before its approve. The merchant
            // presses send once; the conversion is a step, not a chore.
            run.treasury_currency,
            (stage) => setProgress((p) => ({ ...p, [leg.currency]: stage })),
          );
          await recordPayrollLeg(run.id, { currency: leg.currency, tx_hash: txHash });
          setProgress((p) => ({ ...p, [leg.currency]: "paid" }));
        } catch (err) {
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
      setBusy(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto">
      <PageHeader
        title="Payroll"
        description="Pay everybody at once. Nothing moves until you have seen every line."
      />

      {stage === "idle" && (
        // Groups first, as CARDS rather than a dropdown behind a button.
        //
        // This screen used to be one "Run payroll" button with the group
        // hidden in a select underneath it, which got the order backwards: the
        // first decision a merchant makes is WHO is being paid, and a business
        // with three teams should see three teams, not a verb. Picking is the
        // action; the draft follows from it.
        <div className="space-y-4">
          {groups.length === 0 && all.length === 0 && (
            <div className="border border-border p-8 text-center space-y-2">
              <p className="text-ink text-sm">Nobody to pay yet.</p>
              <p className="text-ink-dim text-xs">
                Add the people you pay on the Employees page, group them by
                business, then come back and pay a group at a time.
              </p>
              <Link
                href="/dashboard/employees"
                className="inline-block mt-2 border border-signal/40 text-signal text-xs font-mono px-4 py-2 hover:bg-signal/10 transition-colors"
              >
                Go to Employees
              </Link>
            </div>
          )}

          {(groups.length > 0 || all.length > 0) && (
            <>
              <p className="text-ink-dim text-xs">Who are you paying?</p>

              <div className="grid gap-2 sm:grid-cols-2">
                {groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    disabled={busy || g.members === 0}
                    onClick={() => void build(g.id)}
                    className="text-left border border-border p-4 transition-colors
                               hover:border-signal hover:bg-signal/5
                               disabled:opacity-40 disabled:hover:border-border disabled:hover:bg-transparent"
                  >
                    <p className="text-ink text-sm font-medium">{g.name}</p>
                    <p className="text-ink-dim text-xs mt-0.5 font-mono">
                      {g.members === 0
                        ? "nobody in this group"
                        : `${g.members} ${g.members === 1 ? "person" : "people"}`}
                    </p>
                  </button>
                ))}

                {/* Everybody stays available, but it is no longer the only
                    thing on the screen and no longer the default. */}
                <button
                  type="button"
                  disabled={busy || all.length === 0}
                  onClick={() => void build("")}
                  className="text-left border border-dashed border-border p-4 transition-colors
                             hover:border-ink-dim hover:bg-surface
                             disabled:opacity-40"
                >
                  <p className="text-ink text-sm font-medium">Everyone</p>
                  <p className="text-ink-dim text-xs mt-0.5 font-mono">
                    {all.length} active {all.length === 1 ? "person" : "people"}, every group
                  </p>
                </button>
              </div>

              {groups.length === 0 && (
                <p className="text-ink-dim text-xs">
                  No groups yet — everyone is paid together. Make groups on the{" "}
                  <Link href="/dashboard/employees" className="text-signal hover:underline">
                    Employees
                  </Link>{" "}
                  page to pay one business at a time.
                </p>
              )}

              {busy && <p className="text-ink-dim text-xs font-mono">Building the draft…</p>}
              {error && <p className="text-danger text-xs">{error}</p>}
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
        <Progress run={run} legs={legs} progress={progress} stage={stage} onReset={() => {
          setStage("idle");
          setRun(null);
          setLegs([]);
          setProgress({});
        }} />
      )}

      <History runs={history?.data ?? []} />
    </div>
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

        <table className="w-full text-sm">
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

      <div className="border border-border p-4 space-y-2">
        {run.groups.map((g) => (
          <div key={g.currency} className="flex items-center justify-between text-sm">
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
            <span className="font-mono text-xs">
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
  onReset,
}: {
  run: PayrollRun;
  legs: PayrollLeg[];
  progress: Record<string, string>;
  stage: Stage;
  onReset: () => void;
}) {
  const paid = run.items.filter((i) => i.status === "paid");
  const unpaid = run.items.filter((i) => i.status !== "paid");

  return (
    <div className="space-y-4">
      <div className="border border-border p-4 space-y-2">
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
                Run payroll again to pay the people who were missed. Nobody who
                was already paid will be paid twice.
              </p>
            </div>
          )}

          <button
            type="button"
            onClick={onReset}
            className="border border-border px-4 py-2 text-sm text-ink-dim hover:text-ink"
          >
            Done
          </button>
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
