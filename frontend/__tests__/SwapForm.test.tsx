/**
 * frontend/__tests__/SwapForm.test.tsx
 * Unit test suite for the SwapForm component (#1425).
 *
 * Covers:
 * - Rendering and initial state
 * - Amount input validation (empty, zero, negative, overlong decimals)
 * - Asset pair selection (flip button, auto-flip on duplicate selection)
 * - Slippage tolerance selection
 * - Quote fetching and debouncing
 * - Enabled / disabled submit button states
 * - Successful swap transaction building, signing, and submission
 * - Error handling for failed quotes and failed submissions
 */

import React from "react";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { Asset } from "@stellar/stellar-sdk";
import SwapForm from "../components/SwapForm";
import {
  fetchStrictSendPaths,
  buildPathPaymentStrictSendTransaction,
  submitTransaction,
  getPathPaymentReceivedAmount,
  USDC,
  type StrictSendPathQuote,
} from "@/lib/stellar";
import { signTransactionWithWallet } from "@/lib/wallet";

// ─── Module Mocks ─────────────────────────────────────────────────────────────

jest.mock("@/lib/stellar", () => {
  const actual = jest.requireActual("@/lib/stellar");
  return {
    ...actual,
    fetchStrictSendPaths: jest.fn(),
    buildPathPaymentStrictSendTransaction: jest.fn(),
    submitTransaction: jest.fn(),
    getPathPaymentReceivedAmount: jest.fn(),
  };
});

jest.mock("@/lib/wallet", () => ({
  signTransactionWithWallet: jest.fn(),
}));

jest.mock("@/contexts/I18nContext", () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, any>) => {
      const map: Record<string, string> = {
        "swap.title": "Swap Assets",
        "swap.sell": "You Sell",
        "swap.sellAssetLabel": "Sell Asset",
        "swap.flipAssets": "Flip Assets",
        "swap.estimatedBuy": "Estimated Buy",
        "swap.buyAssetLabel": "Buy Asset",
        "swap.fetchingPath": "Finding best route...",
        "swap.slippageTolerance": "Slippage Tolerance",
        "swap.exchangeRate": "Exchange Rate",
        "swap.minReceived": `Minimum Received (${params?.percent ?? ""})`,
        "swap.pathHops": "Path Hops",
        "swap.noPathFound": "No swap path found for this pair/amount",
        "swap.quoteFetchFailed": "Failed to fetch swap quote",
        "swap.swapping": "Swapping...",
        "swap.action": `Swap ${params?.from ?? ""} to ${params?.to ?? ""}`,
        "swap.signingCancelled": "Transaction signing was cancelled",
        "swap.swapFailed": "Swap failed to execute",
        "swap.successMessage": `Successfully swapped and received ${params?.received ?? ""}`,
      };
      return map[key] || key;
    },
  }),
}));

const mockFetchStrictSendPaths = fetchStrictSendPaths as jest.MockedFunction<typeof fetchStrictSendPaths>;
const mockBuildPathPaymentStrictSendTransaction = buildPathPaymentStrictSendTransaction as jest.MockedFunction<
  typeof buildPathPaymentStrictSendTransaction
>;
const mockSubmitTransaction = submitTransaction as jest.MockedFunction<typeof submitTransaction>;
const mockGetPathPaymentReceivedAmount = getPathPaymentReceivedAmount as jest.MockedFunction<
  typeof getPathPaymentReceivedAmount
>;
const mockSignTransactionWithWallet = signTransactionWithWallet as jest.MockedFunction<
  typeof signTransactionWithWallet
>;

// ─── Test Setup & Helpers ─────────────────────────────────────────────────────

const TEST_PUBLIC_KEY = "GBRPYHIL2CI3WHZDTOOQFC6EB4RRJC3D5NZ2KMSUGSRNVO7ZFGIGSZ";

const mockQuote: StrictSendPathQuote = {
  sourceAmount: "100.0000000",
  destinationAmount: "20.0000000",
  exchangeRate: 0.2,
  path: [],
};

describe("SwapForm Component (#1425)", () => {
  const defaultProps = {
    publicKey: TEST_PUBLIC_KEY,
    onSwapComplete: jest.fn(),
    onError: jest.fn(),
    onSuccess: jest.fn(),
  };

  const advanceDebounce = async (ms = 450) => {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  // ─── 1. Rendering & Initial State ──────────────────────────────────────────

  describe("Rendering & Initial State", () => {
    it("renders the swap form heading, input fields, and submit button", () => {
      render(<SwapForm {...defaultProps} />);

      expect(screen.getByRole("heading", { name: "Swap Assets" })).toBeInTheDocument();
      expect(screen.getByLabelText("Sell Asset")).toBeInTheDocument();
      expect(screen.getByLabelText("You Sell")).toBeInTheDocument();
      expect(screen.getByLabelText("Buy Asset")).toBeInTheDocument();
      expect(screen.getByLabelText("Flip Assets")).toBeInTheDocument();
      expect(screen.getByLabelText("Estimated Buy")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Swap XLM to USDC" })).toBeInTheDocument();
    });

    it("initializes with default assets, empty sell amount, and disabled submit button", () => {
      render(<SwapForm {...defaultProps} />);

      const sellAssetSelect = screen.getByLabelText("Sell Asset") as HTMLSelectElement;
      const buyAssetSelect = screen.getByLabelText("Buy Asset") as HTMLSelectElement;
      const sellAmountInput = screen.getByLabelText("You Sell") as HTMLInputElement;
      const buyEstimateInput = screen.getByLabelText("Estimated Buy") as HTMLInputElement;
      const submitButton = screen.getByRole("button", { name: "Swap XLM to USDC" });

      expect(sellAssetSelect.value).toBe("XLM");
      expect(buyAssetSelect.value).toBe("USDC");
      expect(sellAmountInput.value).toBe("");
      expect(buyEstimateInput.value).toBe("");
      expect(buyEstimateInput).toHaveAttribute("readonly");
      expect(submitButton).toBeDisabled();
    });

    it("renders all four slippage tolerance options and highlights default 0.50%", () => {
      render(<SwapForm {...defaultProps} />);

      const slippage25 = screen.getByRole("button", { name: "0.25%" });
      const slippage50 = screen.getByRole("button", { name: "0.5%" });
      const slippage100 = screen.getByRole("button", { name: "1%" });
      const slippage200 = screen.getByRole("button", { name: "2%" });

      expect(slippage25).toBeInTheDocument();
      expect(slippage50).toBeInTheDocument();
      expect(slippage100).toBeInTheDocument();
      expect(slippage200).toBeInTheDocument();

      expect(slippage50).toHaveClass("border-stellar-500/40", "bg-stellar-500/20", "text-stellar-300");
    });
  });

  // ─── 2. Amount Input Validation ────────────────────────────────────────────

  describe("Amount Input Validation", () => {
    it("does not fetch quote and keeps submit disabled for empty input", async () => {
      render(<SwapForm {...defaultProps} />);
      const sellAmountInput = screen.getByLabelText("You Sell");

      fireEvent.change(sellAmountInput, { target: { value: "" } });
      await advanceDebounce(500);

      expect(mockFetchStrictSendPaths).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Swap XLM to USDC" })).toBeDisabled();
    });

    it("does not fetch quote and keeps submit disabled for zero amount", async () => {
      render(<SwapForm {...defaultProps} />);
      const sellAmountInput = screen.getByLabelText("You Sell");

      fireEvent.change(sellAmountInput, { target: { value: "0" } });
      await advanceDebounce(500);

      expect(mockFetchStrictSendPaths).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Swap XLM to USDC" })).toBeDisabled();
    });

    it("does not fetch quote and keeps submit disabled for negative amount", async () => {
      render(<SwapForm {...defaultProps} />);
      const sellAmountInput = screen.getByLabelText("You Sell");

      fireEvent.change(sellAmountInput, { target: { value: "-10" } });
      await advanceDebounce(500);

      expect(mockFetchStrictSendPaths).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Swap XLM to USDC" })).toBeDisabled();
    });

    it("handles overlong decimals by passing 7-decimal fixed amount to the quote fetcher", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      render(<SwapForm {...defaultProps} />);
      const sellAmountInput = screen.getByLabelText("You Sell");

      fireEvent.change(sellAmountInput, { target: { value: "10.123456789" } });
      await advanceDebounce();

      expect(mockFetchStrictSendPaths).toHaveBeenCalledWith({
        sendAsset: expect.any(Object),
        sendAmount: "10.1234568",
        destAsset: USDC,
      });
    });
  });

  // ─── 3. Asset Pair Selection ───────────────────────────────────────────────

  describe("Asset Pair Selection", () => {
    it("automatically switches buy asset when sell asset is changed to match buy asset", () => {
      render(<SwapForm {...defaultProps} />);
      const sellAssetSelect = screen.getByLabelText("Sell Asset") as HTMLSelectElement;
      const buyAssetSelect = screen.getByLabelText("Buy Asset") as HTMLSelectElement;

      expect(sellAssetSelect.value).toBe("XLM");
      expect(buyAssetSelect.value).toBe("USDC");

      // Change sell asset to USDC -> buy asset must flip to XLM
      fireEvent.change(sellAssetSelect, { target: { value: "USDC" } });
      expect(sellAssetSelect.value).toBe("USDC");
      expect(buyAssetSelect.value).toBe("XLM");
    });

    it("automatically switches sell asset when buy asset is changed to match sell asset", () => {
      render(<SwapForm {...defaultProps} />);
      const sellAssetSelect = screen.getByLabelText("Sell Asset") as HTMLSelectElement;
      const buyAssetSelect = screen.getByLabelText("Buy Asset") as HTMLSelectElement;

      // Change buy asset to XLM -> sell asset must flip to USDC
      fireEvent.change(buyAssetSelect, { target: { value: "XLM" } });
      expect(buyAssetSelect.value).toBe("XLM");
      expect(sellAssetSelect.value).toBe("USDC");
    });

    it("flips asset pair and resets quote when clicking the flip button", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      expect(screen.getByText("Exchange Rate")).toBeInTheDocument();

      const flipButton = screen.getByLabelText("Flip Assets");
      fireEvent.click(flipButton);

      const sellAssetSelect = screen.getByLabelText("Sell Asset") as HTMLSelectElement;
      const buyAssetSelect = screen.getByLabelText("Buy Asset") as HTMLSelectElement;

      expect(sellAssetSelect.value).toBe("USDC");
      expect(buyAssetSelect.value).toBe("XLM");
      // Existing quote details should be cleared
      expect(screen.queryByText("Exchange Rate")).not.toBeInTheDocument();
    });
  });

  // ─── 4. Slippage Tolerance ─────────────────────────────────────────────────

  describe("Slippage Tolerance", () => {
    it("switches active slippage chip and recalculates minimum received amount", async () => {
      mockFetchStrictSendPaths.mockResolvedValue(mockQuote);
      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      // Default slippage is 0.50% (50 bps) -> 20 * (1 - 0.005) = 19.9 USDC
      expect(screen.getByText("19.9 USDC")).toBeInTheDocument();

      // Switch to 1.00% (100 bps) -> 20 * (1 - 0.01) = 19.8 USDC
      const slippage100Btn = screen.getByRole("button", { name: "1%" });
      fireEvent.click(slippage100Btn);

      expect(slippage100Btn).toHaveClass("border-stellar-500/40", "bg-stellar-500/20");
      expect(screen.getByText("19.8 USDC")).toBeInTheDocument();

      // Switch to 2.00% (200 bps) -> 20 * (1 - 0.02) = 19.6 USDC
      const slippage200Btn = screen.getByRole("button", { name: "2%" });
      fireEvent.click(slippage200Btn);

      expect(screen.getByText("19.6 USDC")).toBeInTheDocument();
    });
  });

  // ─── 5. Quote Fetching & Display ───────────────────────────────────────────

  describe("Quote Fetching & Display", () => {
    it("fetches quote after 400ms debounce and displays exchange rate and path hops", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });

      // Before timer expires, fetch should not have run
      expect(mockFetchStrictSendPaths).not.toHaveBeenCalled();

      // Advance past 400ms debounce
      await advanceDebounce();

      expect(mockFetchStrictSendPaths).toHaveBeenCalledTimes(1);
      expect(screen.getByText("Exchange Rate")).toBeInTheDocument();
      expect(screen.getByText("1 XLM ≈ 0.2 USDC")).toBeInTheDocument();
      expect(screen.getByText("Path Hops")).toBeInTheDocument();
    });

    it("displays fetching placeholder in buy estimate field while quote is loading", async () => {
      let resolveQuote: (val: any) => void = () => {};
      const pendingPromise = new Promise((resolve) => {
        resolveQuote = resolve;
      });
      mockFetchStrictSendPaths.mockReturnValueOnce(pendingPromise as any);

      render(<SwapForm {...defaultProps} />);
      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "50" } });

      await advanceDebounce();

      const buyEstimateInput = screen.getByLabelText("Estimated Buy") as HTMLInputElement;
      expect(buyEstimateInput.value).toBe("Finding best route...");

      await act(async () => {
        resolveQuote(mockQuote);
      });

      expect(buyEstimateInput.value).toBe("20");
    });
  });

  // ─── 6. Disabled / Enabled Submit States ───────────────────────────────────

  describe("Submit Button States", () => {
    it("is disabled while quote is in flight", async () => {
      let resolveQuote: (val: any) => void = () => {};
      const pendingPromise = new Promise((resolve) => {
        resolveQuote = resolve;
      });
      mockFetchStrictSendPaths.mockReturnValueOnce(pendingPromise as any);

      render(<SwapForm {...defaultProps} />);
      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "50" } });

      await advanceDebounce();

      const submitButton = screen.getByRole("button", { name: "Swap XLM to USDC" });
      expect(submitButton).toBeDisabled();

      await act(async () => {
        resolveQuote(mockQuote);
      });

      expect(submitButton).toBeEnabled();
    });

    it("is enabled when a valid quote is loaded with non-zero amount", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      const submitButton = screen.getByRole("button", { name: "Swap XLM to USDC" });
      expect(submitButton).toBeEnabled();
    });
  });

  // ─── 7. Successful Swap Execution ──────────────────────────────────────────

  describe("Successful Swap Execution", () => {
    it("submits the swap transaction and triggers success callbacks and resets form", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      mockBuildPathPaymentStrictSendTransaction.mockResolvedValueOnce({
        toXDR: () => "mock-unsigned-xdr",
      } as any);
      mockSignTransactionWithWallet.mockResolvedValueOnce({
        signedXDR: "mock-signed-xdr",
      });
      mockSubmitTransaction.mockResolvedValueOnce({
        hash: "tx-hash-success-123",
      } as any);
      mockGetPathPaymentReceivedAmount.mockResolvedValueOnce("20.0000000");

      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      const submitButton = screen.getByRole("button", { name: "Swap XLM to USDC" });
      expect(submitButton).toBeEnabled();

      await act(async () => {
        fireEvent.click(submitButton);
      });

      expect(mockBuildPathPaymentStrictSendTransaction).toHaveBeenCalledWith({
        fromPublicKey: TEST_PUBLIC_KEY,
        toPublicKey: TEST_PUBLIC_KEY,
        sendAsset: expect.any(Object),
        sendAmount: "100.0000000",
        destAsset: USDC,
        destMin: "19.9000000",
        path: [],
      });

      expect(mockSignTransactionWithWallet).toHaveBeenCalledWith("mock-unsigned-xdr");
      expect(mockSubmitTransaction).toHaveBeenCalledWith("mock-signed-xdr");
      expect(mockGetPathPaymentReceivedAmount).toHaveBeenCalledWith("tx-hash-success-123");

      expect(defaultProps.onSuccess).toHaveBeenCalledWith(
        expect.stringContaining("Successfully swapped and received")
      );
      expect(defaultProps.onSwapComplete).toHaveBeenCalledTimes(1);

      // Form should reset sellAmount and clear quote
      expect((sellAmountInput as HTMLInputElement).value).toBe("");
      expect(screen.queryByText("Exchange Rate")).not.toBeInTheDocument();
    });
  });

  // ─── 8. Error Display Paths ────────────────────────────────────────────────

  describe("Error Display Paths", () => {
    it("displays error message when quote returns null (no path found)", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(null);
      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      expect(screen.getByText("No swap path found for this pair/amount")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Swap XLM to USDC" })).toBeDisabled();
    });

    it("displays error message when fetchStrictSendPaths rejects", async () => {
      mockFetchStrictSendPaths.mockRejectedValueOnce(new Error("Network connection dropped"));
      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      expect(screen.getByText("Network connection dropped")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Swap XLM to USDC" })).toBeDisabled();
    });

    it("calls onError when wallet signing fails or user rejects", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      mockBuildPathPaymentStrictSendTransaction.mockResolvedValueOnce({
        toXDR: () => "mock-unsigned-xdr",
      } as any);
      mockSignTransactionWithWallet.mockResolvedValueOnce({
        signedXDR: undefined,
        error: "Freighter wallet was closed by user",
      });

      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      const submitButton = screen.getByRole("button", { name: "Swap XLM to USDC" });
      await act(async () => {
        fireEvent.click(submitButton);
      });

      expect(defaultProps.onError).toHaveBeenCalledWith("Freighter wallet was closed by user");
      expect(defaultProps.onSuccess).not.toHaveBeenCalled();
      expect(defaultProps.onSwapComplete).not.toHaveBeenCalled();
      // Button returns to enabled after submission error
      expect(submitButton).toBeEnabled();
    });

    it("calls onError when transaction submission fails", async () => {
      mockFetchStrictSendPaths.mockResolvedValueOnce(mockQuote);
      mockBuildPathPaymentStrictSendTransaction.mockResolvedValueOnce({
        toXDR: () => "mock-unsigned-xdr",
      } as any);
      mockSignTransactionWithWallet.mockResolvedValueOnce({
        signedXDR: "mock-signed-xdr",
      });
      mockSubmitTransaction.mockRejectedValueOnce(new Error("tx_bad_seq: sequence number too low"));

      render(<SwapForm {...defaultProps} />);

      const sellAmountInput = screen.getByLabelText("You Sell");
      fireEvent.change(sellAmountInput, { target: { value: "100" } });
      await advanceDebounce();

      const submitButton = screen.getByRole("button", { name: "Swap XLM to USDC" });
      await act(async () => {
        fireEvent.click(submitButton);
      });

      expect(defaultProps.onError).toHaveBeenCalledWith("tx_bad_seq: sequence number too low");
      expect(defaultProps.onSuccess).not.toHaveBeenCalled();
      expect(defaultProps.onSwapComplete).not.toHaveBeenCalled();
      expect(submitButton).toBeEnabled();
    });
  });
});
