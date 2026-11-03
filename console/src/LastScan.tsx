import { useScans } from "./data/context";
import { Time } from "./format";

export function LastScan() {
  const scans = useScans();
  if (scans.status === "loading") {
    return null;
  }
  if (scans.status === "error") {
    return <p className="page-meta">Last scan time is unavailable.</p>;
  }
  const latest = scans.data
    .filter((scan) => scan.status === "succeeded" && scan.startedAt)
    .sort((left, right) => Date.parse(right.startedAt ?? "") - Date.parse(left.startedAt ?? ""))[0];
  return (
    <p className="page-meta">
      {latest ? (
        <>
          Last scan started <Time value={latest.startedAt} />
        </>
      ) : (
        "No scan has finished yet."
      )}
    </p>
  );
}
