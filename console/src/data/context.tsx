import { createContext, useContext, type ReactNode } from "react";
import type { DataSource } from "./types";

const SourceContext = createContext<DataSource | null>(null);

export function DataProvider({ source, children }: { source: DataSource; children: ReactNode }) {
  return <SourceContext.Provider value={source}>{children}</SourceContext.Provider>;
}

export function useSource(): DataSource {
  const source = useContext(SourceContext);
  if (!source) {
    throw new Error("useSource needs a DataProvider above it");
  }
  return source;
}
