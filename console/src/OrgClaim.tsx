import { useState } from "react";
import { failureMessage, toDataError } from "./data/error";
import type { ClaimView } from "./data/types";
import { CLAIM_TITLE, JOIN_TITLE } from "./shell";

/**
 * Org claim screen (#46 / #49). The first person from a tenant to sign in claims the
 * organisation and becomes its owner; everyone after joins it as a member.
 */
export function OrgClaim({
  view,
  signedInAs,
  onClaim,
}: {
  view: ClaimView;
  signedInAs: string | null;
  onClaim: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const joining = view.claimed;
  const action = joining ? "join this organisation" : "claim this organisation";

  async function submit() {
    setBusy(true);
    setFailure("");
    try {
      await onClaim();
    } catch (error) {
      const failed = toDataError(error);
      setFailure(
        failed.code === "claim_role_required"
          ? "Your account does not have the role needed to claim this organisation. Ask the person who administers your organisation to sign in and claim it first; you can then join."
          : failureMessage(failed, action),
      );
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        {joining ? JOIN_TITLE : CLAIM_TITLE}
      </h1>
      <p className="page-description">
        {joining
          ? `This organisation is already set up in Farside with ${view.memberCount} ${view.memberCount === 1 ? "member" : "members"}. Join it to see its estate.`
          : "Nobody from your organisation has set it up in Farside yet. Claiming it makes you its owner. Colleagues who sign in later join it."}
      </p>
      <dl className="panel detail">
        <dt>Organisation</dt>
        <dd>{view.orgId}</dd>
        {signedInAs ? (
          <>
            <dt>Signed in as</dt>
            <dd>{signedInAs}</dd>
          </>
        ) : null}
        <dt>Your role after this step</dt>
        <dd>{joining ? "Member" : "Owner"}</dd>
      </dl>
      <div>
        <button
          className="action action-primary"
          type="button"
          onClick={() => void submit()}
          disabled={busy}
        >
          {busy
            ? joining
              ? "Joining..."
              : "Claiming..."
            : joining
              ? "Join organisation"
              : "Claim organisation"}
        </button>
      </div>
      <p className="notice" role="status" aria-live="polite">
        {busy ? (joining ? "Joining the organisation." : "Claiming the organisation.") : ""}
      </p>
      {failure ? (
        <p className="notice notice-alert" role="alert">
          {failure}
        </p>
      ) : null}
    </>
  );
}
