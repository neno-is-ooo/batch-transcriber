import { useCallback, useEffect, useState } from "react";
import { getProviders as fetchProviders } from "../lib/tauri-commands";
import type { Provider } from "../types/providers";

export interface UseProvidersResult {
  providers: Provider[];
  loading: boolean;
  refresh: () => Promise<void>;
}

export function getAvailableProviders(providers: Provider[]): Provider[] {
  return providers.filter((provider) => provider.available);
}

export function getProviderById(
  providers: Provider[],
  id: string
): Provider | undefined {
  return providers.find((provider) => provider.id === id);
}

export function useProviders(): UseProvidersResult {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  const refresh = useCallback(async () => {
    setLoading(true);

    try {
      const nextProviders = await fetchProviders();
      setProviders(nextProviders);
    } catch (error) {
      console.error("[providers] failed to fetch providers", error);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { providers, loading, refresh };
}
