import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Provider } from "../types/providers";
import { getAvailableProviders, getProviderById, useProviders } from "./useProviders";

const { getProvidersMock } = vi.hoisted(() => ({
  getProvidersMock: vi.fn(),
}));

vi.mock("../lib/tauri-commands", () => ({
  getProviders: getProvidersMock,
}));

function providerFactory(id: string, available: boolean): Provider {
  return {
    id,
    name: id,
    available,
    runtime: {
      type: "PythonUv",
      package: `${id}-pkg`,
      entryPoint: `${id}_entry`,
    },
  };
}

describe("useProviders", () => {
  beforeEach(() => {
    getProvidersMock.mockReset();
  });

  it("fetches providers on mount and clears loading", async () => {
    const providers = [providerFactory("parakeet-coreml", true)];
    getProvidersMock.mockResolvedValueOnce(providers);

    const { result } = renderHook(() => useProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(getProvidersMock).toHaveBeenCalledTimes(1);
    expect(result.current.providers).toEqual(providers);
  });

  it("refreshes provider probe state", async () => {
    const initial = [providerFactory("whisper-openai", true)];
    const refreshed = [
      providerFactory("whisper-openai", true),
      providerFactory("faster-whisper", false),
    ];

    getProvidersMock.mockResolvedValueOnce(initial).mockResolvedValueOnce(refreshed);

    const { result } = renderHook(() => useProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.providers).toEqual(initial);
    });

    await act(async () => {
      await result.current.refresh();
    });

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
      expect(result.current.providers).toEqual(refreshed);
    });

    expect(getProvidersMock).toHaveBeenCalledTimes(2);
  });

  it("logs and recovers when provider fetch fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    getProvidersMock.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useProviders());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.providers).toEqual([]);
    expect(errorSpy).toHaveBeenCalledWith(
      "[providers] failed to fetch providers",
      expect.any(Error)
    );
  });

  it("filters and finds providers using helper functions", () => {
    const providers = [
      providerFactory("parakeet-coreml", true),
      providerFactory("whisper-openai", false),
    ];

    expect(getAvailableProviders(providers).map((provider) => provider.id)).toEqual([
      "parakeet-coreml",
    ]);
    expect(getProviderById(providers, "whisper-openai")?.available).toBe(false);
    expect(getProviderById(providers, "missing")).toBeUndefined();
  });
});
