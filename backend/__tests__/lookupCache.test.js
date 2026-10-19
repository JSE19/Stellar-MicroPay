/**
 * __tests__/lookupCache.test.js
 * Tests for caching federation and account lookups with explicit TTLs (#1421).
 *
 * Acceptance Criteria verified:
 *  - Account/trustline/federation lookups cached with per-type TTLs, configurable via env
 *  - Cache keys namespaced; invalidation path documented and tested
 *  - Negative results (account not found) cached with a shorter TTL
 *  - Tests assert cache hit avoids a second Horizon call and TTL expiry refetches
 */

"use strict";

const mockLoadAccount = jest.fn();
const mockSubmitTransaction = jest.fn();

jest.mock("@stellar/stellar-sdk", () => {
  return {
    Horizon: {
      Server: jest.fn(() => ({
        loadAccount: mockLoadAccount,
        submitTransaction: mockSubmitTransaction,
        payments: jest.fn(() => ({
          forAccount: jest.fn(() => ({
            limit: jest.fn(() => ({
              order: jest.fn(() => ({
                call: jest.fn().mockResolvedValue({ records: [] }),
              })),
            })),
          })),
        })),
      })),
    },
    TransactionBuilder: {
      fromXDR: jest.fn(() => ({
        source: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      })),
    },
    Networks: {
      TESTNET: "Test SDF Network ; September 2015",
      PUBLIC: "Public Global Stellar Network ; September 2015",
    },
  };
});

jest.mock("../src/services/usernameService", () => ({
  resolveUsername: jest.fn(),
  getAllUsernames: jest.fn(),
}));

const cache = require("../src/services/cache");
const stellarService = require("../src/services/stellarService");
const federationController = require("../src/controllers/federationController");
const usernameService = require("../src/services/usernameService");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Account, Trustline & Federation Lookup Cache (#1421)", () => {
  const testPublicKey = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
  const mockAccountData = {
    sequence: "1000",
    subentry_count: 3,
    balances: [
      { asset_type: "native", balance: "150.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        balance: "25.0000000",
        limit: "1000.0000000",
      },
    ],
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    await cache.clear();
  });

  describe("Cache Key Namespacing & TTL Configuration", () => {
    it("namespaces cache keys appropriately", () => {
      expect(cache.accountKey(testPublicKey)).toBe(`account:${testPublicKey}`);
      expect(cache.trustlineKey(testPublicKey, "usdc")).toBe(`trustline:${testPublicKey}:usdc`);
      expect(cache.federationKey("name", "Alice*StellarMicroPay.com")).toBe(
        "federation:name:alice*stellarmicropay.com"
      );
      expect(cache.federationKey("id", testPublicKey)).toBe(
        `federation:id:${testPublicKey}`
      );
    });

    it("reads per-type TTLs from environment variables with proper defaults", () => {
      delete process.env.ACCOUNT_CACHE_TTL_MS;
      delete process.env.TRUSTLINE_CACHE_TTL_MS;
      delete process.env.FEDERATION_CACHE_TTL_MS;
      delete process.env.NEGATIVE_CACHE_TTL_MS;

      expect(cache.getAccountCacheTtlMs()).toBe(60000);
      expect(cache.getTrustlineCacheTtlMs()).toBe(60000);
      expect(cache.getFederationCacheTtlMs()).toBe(300000);
      expect(cache.getNegativeCacheTtlMs()).toBe(10000);

      process.env.ACCOUNT_CACHE_TTL_MS = "5000";
      process.env.TRUSTLINE_CACHE_TTL_MS = "4000";
      process.env.FEDERATION_CACHE_TTL_MS = "8000";
      process.env.NEGATIVE_CACHE_TTL_MS = "1500";

      expect(cache.getAccountCacheTtlMs()).toBe(5000);
      expect(cache.getTrustlineCacheTtlMs()).toBe(4000);
      expect(cache.getFederationCacheTtlMs()).toBe(8000);
      expect(cache.getNegativeCacheTtlMs()).toBe(1500);

      delete process.env.ACCOUNT_CACHE_TTL_MS;
      delete process.env.TRUSTLINE_CACHE_TTL_MS;
      delete process.env.FEDERATION_CACHE_TTL_MS;
      delete process.env.NEGATIVE_CACHE_TTL_MS;
    });
  });

  describe("Account Lookup Caching (stellarService.getAccount)", () => {
    it("cache hit avoids a second Horizon loadAccount call", async () => {
      mockLoadAccount.mockResolvedValue(mockAccountData);

      // First call: cache miss, hits Horizon
      const account1 = await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
      expect(account1.publicKey).toBe(testPublicKey);
      expect(account1.balances).toHaveLength(2);

      // Second call: cache hit, avoids Horizon
      const account2 = await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
      expect(account2).toEqual(account1);
    });

    it("TTL expiry refetches from Horizon", async () => {
      process.env.ACCOUNT_CACHE_TTL_MS = "40"; // 40 ms TTL
      mockLoadAccount.mockResolvedValue(mockAccountData);

      // Call 1: Miss
      await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Wait for TTL to expire
      await sleep(60);

      // Call 2: Expired, refetches from Horizon
      await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      delete process.env.ACCOUNT_CACHE_TTL_MS;
    });

    it("getXLMBalance and getAccountAssets leverage the account cache", async () => {
      mockLoadAccount.mockResolvedValue(mockAccountData);

      const balance = await stellarService.getXLMBalance(testPublicKey);
      expect(balance).toBe("150.0000000");
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      const assets = await stellarService.getAccountAssets(testPublicKey);
      expect(assets).toHaveLength(1);
      expect(assets[0].assetCode).toBe("USDC");
      // Still 1 Horizon call because getAccount cache was hit!
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });
  });

  describe("Trustline Lookup Caching (stellarService.hasUSDCTrustline)", () => {
    it("cache hit avoids a second Horizon call", async () => {
      mockLoadAccount.mockResolvedValue(mockAccountData);

      // First call: fetches from Horizon
      const hasTrustline1 = await stellarService.hasUSDCTrustline(testPublicKey);
      expect(hasTrustline1).toBe(true);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Second call: hits cache
      const hasTrustline2 = await stellarService.hasUSDCTrustline(testPublicKey);
      expect(hasTrustline2).toBe(true);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);
    });

    it("TTL expiry refetches trustline data from Horizon", async () => {
      process.env.TRUSTLINE_CACHE_TTL_MS = "40";
      mockLoadAccount.mockResolvedValue(mockAccountData);

      await stellarService.hasUSDCTrustline(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      await sleep(60);

      await stellarService.hasUSDCTrustline(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      delete process.env.TRUSTLINE_CACHE_TTL_MS;
    });
  });

  describe("Negative Result Caching (Account Not Found 404)", () => {
    it("caches 404 account not found with shorter TTL and avoids second Horizon call", async () => {
      process.env.NEGATIVE_CACHE_TTL_MS = "60";
      const notFoundErr = new Error("Not found");
      notFoundErr.response = { status: 404 };
      mockLoadAccount.mockRejectedValue(notFoundErr);

      // Call 1: Misses cache, Horizon returns 404
      await expect(stellarService.getAccount(testPublicKey)).rejects.toMatchObject({
        status: 404,
      });
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Call 2: Hits negative cache, throws immediately without calling Horizon
      await expect(stellarService.getAccount(testPublicKey)).rejects.toMatchObject({
        status: 404,
      });
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Wait for negative TTL to expire
      await sleep(80);

      // Call 3: Negative TTL expired, refetches from Horizon
      await expect(stellarService.getAccount(testPublicKey)).rejects.toMatchObject({
        status: 404,
      });
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      delete process.env.NEGATIVE_CACHE_TTL_MS;
    });

    it("caches 404 negative result in hasUSDCTrustline", async () => {
      process.env.NEGATIVE_CACHE_TTL_MS = "60";
      const notFoundErr = new Error("Not found");
      notFoundErr.response = { status: 404 };
      mockLoadAccount.mockRejectedValue(notFoundErr);

      await expect(stellarService.hasUSDCTrustline(testPublicKey)).rejects.toMatchObject({
        status: 404,
      });
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Second call hits negative cache
      await expect(stellarService.hasUSDCTrustline(testPublicKey)).rejects.toMatchObject({
        status: 404,
      });
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      await sleep(80);

      await expect(stellarService.hasUSDCTrustline(testPublicKey)).rejects.toMatchObject({
        status: 404,
      });
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      delete process.env.NEGATIVE_CACHE_TTL_MS;
    });
  });

  describe("Federation Resolution Caching (federationController.resolveFederation)", () => {
    it("cache hit avoids duplicate lookup", async () => {
      usernameService.resolveUsername.mockReturnValue({
        username: "carol",
        publicKey: testPublicKey,
      });

      const req = {
        query: { q: "carol*stellarmicropay.com", type: "name" },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const next = jest.fn();

      // First call: cache miss
      await federationController.resolveFederation(req, res, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(1);
      expect(res.json).toHaveBeenCalledWith({
        stellar_address: "carol*stellarmicropay.com",
        account_id: testPublicKey,
      });

      // Second call: cache hit
      const res2 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await federationController.resolveFederation(req, res2, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(1);
      expect(res2.json).toHaveBeenCalledWith({
        stellar_address: "carol*stellarmicropay.com",
        account_id: testPublicKey,
      });
    });

    it("federation TTL expiry refetches resolution", async () => {
      process.env.FEDERATION_CACHE_TTL_MS = "40";
      usernameService.resolveUsername.mockReturnValue({
        username: "dave",
        publicKey: testPublicKey,
      });

      const req = {
        query: { q: "dave*stellarmicropay.com", type: "name" },
      };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const next = jest.fn();

      await federationController.resolveFederation(req, res, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(1);

      await sleep(60);

      const res2 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await federationController.resolveFederation(req, res2, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(2);

      delete process.env.FEDERATION_CACHE_TTL_MS;
    });

    it("negative federation resolution (404) is cached with shorter TTL", async () => {
      process.env.NEGATIVE_CACHE_TTL_MS = "50";
      const notFoundErr = new Error("Username not found");
      notFoundErr.status = 404;
      usernameService.resolveUsername.mockImplementation(() => {
        throw notFoundErr;
      });

      const req = {
        query: { q: "unknown*stellarmicropay.com", type: "name" },
      };
      const res1 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      const next = jest.fn();

      await federationController.resolveFederation(req, res1, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(1);
      expect(res1.status).toHaveBeenCalledWith(404);
      expect(res1.json).toHaveBeenCalledWith({ error: "Username not found" });

      // Second call: should hit negative cache without calling usernameService again
      const res2 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await federationController.resolveFederation(req, res2, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(1);
      expect(res2.status).toHaveBeenCalledWith(404);
      expect(res2.json).toHaveBeenCalledWith({ error: "Username not found" });

      // Wait for negative TTL to expire
      await sleep(70);

      const res3 = { json: jest.fn(), status: jest.fn().mockReturnThis() };
      await federationController.resolveFederation(req, res3, next);
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(2);

      delete process.env.NEGATIVE_CACHE_TTL_MS;
    });
  });

  describe("Cache Invalidation Path", () => {
    it("clearAccountCache invalidates account and trustline entries", async () => {
      mockLoadAccount.mockResolvedValue(mockAccountData);

      await stellarService.getAccount(testPublicKey);
      await stellarService.hasUSDCTrustline(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      // Verify cached
      await stellarService.getAccount(testPublicKey);
      await stellarService.hasUSDCTrustline(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);

      // Invalidate specifically for testPublicKey
      await stellarService.clearAccountCache(testPublicKey);

      // Both should now refetch
      await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(3);

      await stellarService.hasUSDCTrustline(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(4);
    });

    it("submitTransaction invalidates source account cache upon success", async () => {
      mockLoadAccount.mockResolvedValue(mockAccountData);
      mockSubmitTransaction.mockResolvedValue({ hash: "tx123", ledger: 100, successful: true });

      // Populate account cache
      await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(1);

      // Submitting transaction should invalidate the source account
      await stellarService.submitTransaction("AAAA...");

      // Next getAccount should refetch
      await stellarService.getAccount(testPublicKey);
      expect(mockLoadAccount).toHaveBeenCalledTimes(2);
    });

    it("clearFederationCache invalidates cached federation resolution", async () => {
      usernameService.resolveUsername.mockReturnValue({
        username: "eve",
        publicKey: testPublicKey,
      });

      const req = { query: { q: "eve*stellarmicropay.com", type: "name" } };
      const res = { json: jest.fn(), status: jest.fn().mockReturnThis() };

      await federationController.resolveFederation(req, res, jest.fn());
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(1);

      // Invalidate
      await federationController.clearFederationCache("eve*stellarmicropay.com", "name");

      // Refetches
      await federationController.resolveFederation(req, res, jest.fn());
      expect(usernameService.resolveUsername).toHaveBeenCalledTimes(2);
    });
  });
});
