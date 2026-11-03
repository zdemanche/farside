import { createContext, useContext, type ReactNode } from "react";
import type { DataSource, EstateOverview, ScanRow } from "./types";
import { useResource, type Resource } from "./use-resource";

type Shared = {
  source: DataSource;
  overview: Resource<EstateOverview>;
  scans: Resource<ScanRow[]>;
};

const SharedContext = createContext<Shared | null>(null);

export function DataProvider({ source, children }: { source: DataSource; children: ReactNode }) {
  const overview = useResource((signal) => source.overview(signal), [source]);
  const scans = useResource((signal) => source.scans(signal), [source]);
  return (
    <SharedContext.Provider value={{ source, overview, scans }}>{children}</SharedContext.Provider>
  );
}

function useShared(): Shared {
  const shared = useContext(SharedContext);
  if (!shared) {
    throw new Error("useSource needs a DataProvider above it");
  }
  return shared;
}

export const useSource = (): DataSource => useShared().source;

export const useOverview = (): Resource<EstateOverview> => useShared().overview;

export const useScans = (): Resource<ScanRow[]> => useShared().scans;
