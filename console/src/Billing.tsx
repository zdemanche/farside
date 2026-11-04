import { useSource } from "./data/context";
import type { BillingView, ContractState } from "./data/types";
import { useResource } from "./data/use-resource";
import { formatAmount, Time } from "./format";
import { ScreenState } from "./ScreenState";

const STATE_LABEL: Record<ContractState, string> = {
  active: "Active",
  warning: "Payment overdue: warning",
  grace: "Payment overdue: grace period",
  paused: "Paused: scans are stopped until the account is paid",
  retaining: "Ending: scans are stopped and data is retained until the date below",
  ended: "Ended",
};

function BillingBody({ billing }: { billing: BillingView }) {
  const { contract } = billing;
  return (
    <>
      {billing.canScan ? null : (
        <p className="notice" role="status">
          Scans are stopped. Your existing results stay readable.
        </p>
      )}
      <dl className="facts">
        <dt>Plan</dt>
        <dd>{contract.plan}</dd>
        <dt>Status</dt>
        <dd>{STATE_LABEL[contract.state]}</dd>
        <dt>Amount due</dt>
        <dd>{formatAmount(contract.amountDue, contract.currency)}</dd>
        <dt>Started</dt>
        <dd>
          <Time value={contract.startDate} dateOnly />
        </dd>
        {contract.endDate ? (
          <>
            <dt>Ends</dt>
            <dd>
              <Time value={contract.endDate} dateOnly />
            </dd>
          </>
        ) : null}
        {billing.retainUntil ? (
          <>
            <dt>Data kept until</dt>
            <dd>
              <Time value={billing.retainUntil} dateOnly />
            </dd>
          </>
        ) : null}
      </dl>
      <h2>Invoices</h2>
      {billing.invoices.length === 0 ? <p>No invoices have been issued yet.</p> : null}
      <p className="page-meta">Farside holds no card details.</p>
    </>
  );
}

export function Billing() {
  const source = useSource();
  const billing = useResource((signal) => source.billing(signal), [source]);
  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        Billing
      </h1>
      <p className="page-description">Your plan, what is due, and any invoices.</p>
      <ScreenState
        label="billing"
        resource={billing}
        missing={
          <>
            No contract is set up for this account yet. Moonaan sets it up before your first scan.
          </>
        }
      >
        {(data) => <BillingBody billing={data} />}
      </ScreenState>
    </>
  );
}
