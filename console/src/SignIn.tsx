import { useState } from "react";
import { SIGN_IN_TITLE } from "./shell";

/** Sign-in screen (#49). The button starts the OIDC authorization code + PKCE redirect. */
export function SignIn({
  providerName,
  onSignIn,
  problem,
}: {
  providerName: string;
  onSignIn: () => Promise<void>;
  problem?: string | null;
}) {
  const [redirecting, setRedirecting] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const shown = failure ?? problem ?? null;

  async function start() {
    setFailure(null);
    setRedirecting(true);
    try {
      await onSignIn();
    } catch (error) {
      setRedirecting(false);
      setFailure(error instanceof Error ? error.message : `Could not reach ${providerName}.`);
    }
  }

  return (
    <>
      <h1 className="page-title" id="page-title" tabIndex={-1}>
        {SIGN_IN_TITLE}
      </h1>
      <p className="page-description">
        Sign in with your {providerName} account to see your organisation&apos;s cloud estate.
        Farside only reads your estate; it never asks for cloud credentials here.
      </p>
      <div className="panel">
        <button
          className="action action-primary"
          type="button"
          onClick={() => void start()}
          disabled={redirecting}
        >
          {redirecting ? `Opening ${providerName}...` : `Sign in with ${providerName}`}
        </button>
      </div>
      <p className="notice" role="status" aria-live="polite">
        {redirecting ? `Taking you to ${providerName} to sign in.` : ""}
      </p>
      {shown ? (
        <p className="notice notice-alert" role="alert">
          {shown}
        </p>
      ) : null}
    </>
  );
}
