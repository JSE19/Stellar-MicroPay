/**
 * src/services/cache.js
 * Redis-backed caching layer with in-memory fallback (#1072, #1421).
 *
 * Supports namespaced caches with explicit, per-type TTLs:
 *  - Analytics: ANALYTICS_CACHE_TTL_MS (default: 5 minutes)
 *  - Account lookups: ACCOUNT_CACHE_TTL_MS (default: 60 seconds, key: "account:<publicKey>")
 *  - Trustline lookups: TRUSTLINE_CACHE_TTL_MS (default: 60 seconds, key: "trustline:<publicKey>:<asset>")
 *  - Federation resolutions: FEDERATION_CACHE_TTL_MS (default: 5 minutes, key: "federation:<type>:<query>")
 *  - Negative results: NEGATIVE_CACHE_TTL_MS (default: 10 seconds)
 *
 * Cache Invalidation Path:
 *  - Invalidation by key: cache.del(key) removes single lookup entries.
 *  - Invalidation by namespace/prefix: cache.clearByPrefix(prefix) removes matching keys
 *    (e.g., cache.clearByPrefix("account:") or cache.clearByPrefix("federation:")).
 *  - Programmatic invalidation helpers:
 *      * stellarService.clearAccountCache(publicKey) invalidates account and trustline entries.
 *      * federationController.clearFederationCache(query, type) invalidates federation lookups.
 *  - Automatic write invalidation: submitTransaction(signedXDR) invalidates source account cache.
 *  - Automatic TTL expiration: entries expire automatically in Redis (via SETEX) and in memory (via timestamp checks).
 */

"use strict";

const DEFAULT_ANALYTICS_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_ACCOUNT_TTL_MS = 60 * 1000; // 60 seconds
const DEFAULT_TRUSTLINE_TTL_MS = 60 * 1000; // 60 seconds
const DEFAULT_FEDERATION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_NEGATIVE_TTL_MS = 10 * 1000; // 10 seconds

const REDIS_URL = process.env.REDIS_URL || null;
const MAX_MEMORY_ENTRIES = parseInt(
  process.env.ANALYTICS_CACHE_MAX_ENTRIES || "500",
  10,
);

function parseTtl(envVal, fallbackMs) {
  if (envVal === undefined || envVal === null || envVal === "") return fallbackMs;
  const parsed = parseInt(envVal, 10);
  return !isNaN(parsed) && parsed >= 0 ? parsed : fallbackMs;
}

function getAnalyticsCacheTtlMs() {
  return parseTtl(process.env.ANALYTICS_CACHE_TTL_MS, DEFAULT_ANALYTICS_TTL_MS);
}

function getAccountCacheTtlMs() {
  return parseTtl(process.env.ACCOUNT_CACHE_TTL_MS, DEFAULT_ACCOUNT_TTL_MS);
}

function getTrustlineCacheTtlMs() {
  return parseTtl(process.env.TRUSTLINE_CACHE_TTL_MS, DEFAULT_TRUSTLINE_TTL_MS);
}

function getFederationCacheTtlMs() {
  return parseTtl(process.env.FEDERATION_CACHE_TTL_MS, DEFAULT_FEDERATION_TTL_MS);
}

function getNegativeCacheTtlMs() {
  return parseTtl(
    process.env.NEGATIVE_CACHE_TTL_MS || process.env.ACCOUNT_NEGATIVE_CACHE_TTL_MS,
    DEFAULT_NEGATIVE_TTL_MS
  );
}

const CACHE_NAMESPACES = {
  ACCOUNT: "account:",
  TRUSTLINE: "trustline:",
  FEDERATION: "federation:",
  ANALYTICS: "analytics:",
};

function accountKey(publicKey) {
  return `account:${publicKey}`;
}

function trustlineKey(publicKey, asset = "usdc") {
  return `trustline:${publicKey}:${asset.toLowerCase()}`;
}

function federationKey(type, query) {
  const normalized =
    type === "name" ? String(query).toLowerCase().trim() : String(query).trim();
  return `federation:${type}:${normalized}`;
}

class AnalyticsCache {
  constructor() {
    /** @type {Map<string, { data: *, timestamp: number, ttlMs: number, expiresAt: number }>} */
    this.memoryCache = new Map();
    /** @type {import("redis").RedisClientType | null} */
    this.redisClient = null;
    this.usingRedis = false;

    this._initRedis();
  }

  /**
   * Attempt to create and connect a Redis client.
   * Silently falls back to in-memory when Redis is unavailable so the
   * service degrades gracefully rather than crashing on startup.
   */
  _initRedis() {
    if (!REDIS_URL) {
      return;
    }

    try {
      const { createClient } = require("redis");
      this.redisClient = createClient({ url: REDIS_URL });

      this.redisClient.on("error", (err) => {
        console.error(
          "[analytics-cache] Redis error — falling back to memory cache:",
          err.message,
        );
        this.usingRedis = false;
      });

      this.redisClient
        .connect()
        .then(() => {
          this.usingRedis = true;
          console.info("[analytics-cache] Connected to Redis at", REDIS_URL);
        })
        .catch((err) => {
          console.error(
            "[analytics-cache] Redis connection failed — falling back to memory cache:",
            err.message,
          );
          this.usingRedis = false;
        });
    } catch (err) {
      console.error(
        "[analytics-cache] Failed to initialise Redis — falling back to memory cache:",
        err.message,
      );
      this.usingRedis = false;
    }
  }

  /**
   * Retrieve a value from the cache.
   * @param {string} key
   * @returns {Promise<*>} The cached value or `null` if not found / expired.
   */
  async get(key) {
    if (this.usingRedis && this.redisClient) {
      try {
        const raw = await this.redisClient.get(key);
        if (raw !== null) {
          return JSON.parse(raw);
        }
        return null;
      } catch (err) {
        console.error(
          "[analytics-cache] Redis GET failed — falling back to memory:",
          err.message,
        );
        this.usingRedis = false;
        return this._getMemory(key);
      }
    }

    return this._getMemory(key);
  }

  /**
   * Retrieve from the in-memory fallback, honouring TTL.
   * @param {string} key
   * @returns {*|null}
   */
  _getMemory(key) {
    const entry = this.memoryCache.get(key);
    if (!entry) {
      return null;
    }

    const ttl =
      typeof entry.ttlMs === "number" ? entry.ttlMs : getAnalyticsCacheTtlMs();
    const isExpired = entry.expiresAt
      ? Date.now() >= entry.expiresAt
      : Date.now() - entry.timestamp >= ttl;

    if (!isExpired) {
      // Refresh recency (LRU): move to the end of the Map.
      this.memoryCache.delete(key);
      this.memoryCache.set(key, entry);
      return entry.data;
    }

    this.memoryCache.delete(key);
    return null;
  }

  _setMemory(key, value, ttlMs) {
    const effectiveTtlMs =
      typeof ttlMs === "number" && !isNaN(ttlMs)
        ? ttlMs
        : getAnalyticsCacheTtlMs();

    this.memoryCache.delete(key);
    this.memoryCache.set(key, {
      data: value,
      timestamp: Date.now(),
      ttlMs: effectiveTtlMs,
      expiresAt: Date.now() + effectiveTtlMs,
    });
    while (this.memoryCache.size > MAX_MEMORY_ENTRIES) {
      this.memoryCache.delete(this.memoryCache.keys().next().value);
    }
  }

  /**
   * Store a value in the cache with the configured or explicit TTL.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs] Explicit TTL in milliseconds; defaults to configured analytics TTL.
   * @returns {Promise<void>}
   */
  async set(key, value, ttlMs) {
    const effectiveTtlMs =
      typeof ttlMs === "number" && !isNaN(ttlMs)
        ? ttlMs
        : getAnalyticsCacheTtlMs();

    if (this.usingRedis && this.redisClient) {
      try {
        const ttlSeconds = Math.max(1, Math.floor(effectiveTtlMs / 1000));
        await this.redisClient.setEx(key, ttlSeconds, JSON.stringify(value));
        return;
      } catch (err) {
        console.error(
          "[analytics-cache] Redis SET failed — falling back to memory:",
          err.message,
        );
        this.usingRedis = false;
      }
    }

    this._setMemory(key, value, effectiveTtlMs);
  }

  /**
   * Delete a single key from the cache.
   * @param {string} key
   * @returns {Promise<void>}
   */
  async del(key) {
    if (this.usingRedis && this.redisClient) {
      try {
        await this.redisClient.del(key);
      } catch {
        // Ignore Redis errors during deletion; memory is best-effort too.
      }
    }
    this.memoryCache.delete(key);
  }

  /**
   * Delete every key that starts with `prefix`.
   * @param {string} prefix
   * @returns {Promise<number>} Number of keys removed.
   */
  async clearByPrefix(prefix) {
    const removed = new Set();

    if (this.usingRedis && this.redisClient) {
      try {
        const keys = await this.redisClient.keys(`${prefix}*`);
        if (keys.length > 0) {
          await this.redisClient.del(keys);
          keys.forEach((k) => removed.add(k));
        }
      } catch {
        // Fall through to memory cleanup.
      }
    }

    for (const key of [...this.memoryCache.keys()]) {
      if (key.startsWith(prefix)) {
        this.memoryCache.delete(key);
        removed.add(key);
      }
    }

    return removed.size;
  }

  /**
   * Clear the entire cache.
   */
  async clear() {
    if (this.usingRedis && this.redisClient) {
      try {
        await this.redisClient.flushDb();
      } catch {
        // Ignore errors during clearing
      }
    }
    this.memoryCache.clear();
  }

  clearSync() {
    this.memoryCache.clear();
  }

  /**
   * Synchronous read that checks memory only (used internally and in tests
   * that do not have Redis configured).
   * @param {string} key
   * @returns {*|null}
   */
  getSync(key) {
    return this._getMemory(key);
  }

  /**
   * Synchronous write to memory only.
   * @param {string} key
   * @param {*} value
   * @param {number} [ttlMs]
   */
  setSync(key, value, ttlMs) {
    this._setMemory(key, value, ttlMs);
  }

  /**
   * Whether the Redis backend is currently active.
   * @returns {boolean}
   */
  isUsingRedis() {
    return this.usingRedis;
  }
}

const cacheInstance = new AnalyticsCache();
cacheInstance.AnalyticsCache = AnalyticsCache;
cacheInstance.DEFAULT_ANALYTICS_TTL_MS = DEFAULT_ANALYTICS_TTL_MS;
cacheInstance.DEFAULT_ACCOUNT_TTL_MS = DEFAULT_ACCOUNT_TTL_MS;
cacheInstance.DEFAULT_TRUSTLINE_TTL_MS = DEFAULT_TRUSTLINE_TTL_MS;
cacheInstance.DEFAULT_FEDERATION_TTL_MS = DEFAULT_FEDERATION_TTL_MS;
cacheInstance.DEFAULT_NEGATIVE_TTL_MS = DEFAULT_NEGATIVE_TTL_MS;
cacheInstance.CACHE_NAMESPACES = CACHE_NAMESPACES;

cacheInstance.getAnalyticsCacheTtlMs = getAnalyticsCacheTtlMs;
cacheInstance.getAccountCacheTtlMs = getAccountCacheTtlMs;
cacheInstance.getTrustlineCacheTtlMs = getTrustlineCacheTtlMs;
cacheInstance.getFederationCacheTtlMs = getFederationCacheTtlMs;
cacheInstance.getNegativeCacheTtlMs = getNegativeCacheTtlMs;

cacheInstance.accountKey = accountKey;
cacheInstance.trustlineKey = trustlineKey;
cacheInstance.federationKey = federationKey;

module.exports = cacheInstance;
