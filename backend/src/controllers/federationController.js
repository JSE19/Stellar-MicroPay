/**
 * src/controllers/federationController.js
 * Handles federation requests per SEP-0002.
 * Supports namespaced caching with configurable FEDERATION_CACHE_TTL_MS and
 * negative result caching with NEGATIVE_CACHE_TTL_MS (#1421).
 */

"use strict";

const axios = require("axios");
const usernameService = require("../services/usernameService");
const cache = require("../services/cache");

/**
 * Invalidate cached federation resolutions. Part of cache invalidation path (#1421).
 * @param {string} [query] The query string (stellar address or account ID) to invalidate.
 * @param {"name"|"id"} [type] The query type.
 */
async function clearFederationCache(query, type) {
  if (query && type) {
    const key = cache.federationKey(type, query);
    await cache.del(key);
  } else if (query) {
    await cache.clearByPrefix(`federation:name:${String(query).toLowerCase().trim()}`);
    await cache.clearByPrefix(`federation:id:${String(query).trim()}`);
  } else {
    await cache.clearByPrefix("federation:");
  }
}

/**
 * Clean up federation caches between Jest tests so unit test suites
 * remain isolated and deterministic.
 */
if (typeof afterEach === "function") {
  afterEach(async () => {
    await clearFederationCache();
  });
}

/**
 * GET /federation?q=<query>&type=<type>
 * Federation endpoint per SEP-0002.
 */
async function resolveFederation(req, res, next) {
  try {
    const { q, type } = req.query;

    if (!q || !type) {
      return res.status(400).json({
        error: "Missing required parameters: q and type",
      });
    }

    if (type !== "name" && type !== "id") {
      return res.status(400).json({
        error: "Invalid type parameter. Must be 'name' or 'id'",
      });
    }

    const cacheKey = cache.federationKey(type, q);
    const cached = await cache.get(cacheKey);

    if (cached) {
      if (cached.__notFound) {
        return res.status(404).json({
          error: cached.error || "Not found",
        });
      }
      return res.json(cached);
    }

    let result;
    try {
      if (type === "name") {
        result = await resolveStellarAddress(q);
      } else {
        result = await resolveAccountId(q);
      }
    } catch (lookupErr) {
      const isNotFound =
        (lookupErr.response && lookupErr.response.status === 404) ||
        lookupErr.status === 404;

      if (isNotFound) {
        const negativeTtlMs = cache.getNegativeCacheTtlMs();
        const errorMessage = lookupErr.status === 404 ? lookupErr.message : "Not found";
        await cache.set(
          cacheKey,
          { __notFound: true, status: 404, error: errorMessage },
          negativeTtlMs
        );
        return res.status(404).json({
          error: errorMessage,
        });
      }
      throw lookupErr;
    }

    const federationTtlMs = cache.getFederationCacheTtlMs();
    await cache.set(cacheKey, result, federationTtlMs);
    return res.json(result);
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return res.status(404).json({
        error: "Not found",
      });
    }
    next(err);
  }
}

/**
 * Resolve a stellar address (user*domain.com) to an account ID.
 * @param {string} stellarAddress - The stellar address to resolve
 * @returns {Object} Federation response
 */
async function resolveStellarAddress(stellarAddress) {
  // Parse the stellar address
  const parts = stellarAddress.split("*");
  if (parts.length !== 2) {
    const error = new Error("Invalid stellar address format");
    error.status = 400;
    throw error;
  }

  const [username, domain] = parts;

  // Check if it's our domain
  const ourDomain = process.env.DOMAIN || "stellarmicropay.com";
  if (domain === ourDomain) {
    // Local resolution
    const result = usernameService.resolveUsername(username);
    return {
      stellar_address: stellarAddress,
      account_id: result.publicKey,
    };
  } else {
    // Forward federation to external server
    return await forwardFederation(stellarAddress, "name");
  }
}

/**
 * Resolve an account ID to a stellar address.
 * @param {string} accountId - The account ID to resolve
 * @returns {Object} Federation response
 */
async function resolveAccountId(accountId) {
  // First check local usernames
  const allUsernames = usernameService.getAllUsernames();
  const match = allUsernames.find(user => user.publicKey === accountId);

  if (match) {
    const domain = process.env.DOMAIN || "stellarmicropay.com";
    return {
      stellar_address: `${match.username}*${domain}`,
    };
  }

  // If not found locally, we don't support reverse federation for external addresses
  // per SEP-0002, reverse federation is optional
  const error = new Error("Account ID not found");
  error.status = 404;
  throw error;
}

/**
 * Forward federation request to external federation server.
 * @param {string} query - The query to forward
 * @param {string} type - The type of query
 * @returns {Object} Federation response
 */
async function forwardFederation(query, type) {
  // Parse domain from stellar address
  const parts = query.split("*");
  if (parts.length !== 2) {
    throw new Error("Invalid stellar address format");
  }

  const domain = parts[1];

  // Fetch stellar.toml from the domain
  const tomlUrl = `https://${domain}/.well-known/stellar.toml`;
  const tomlResponse = await axios.get(tomlUrl, { timeout: 5000 });
  const tomlContent = tomlResponse.data;

  // Parse TOML to find FEDERATION_SERVER
  const federationServer = parseFederationServer(tomlContent);
  if (!federationServer) {
    throw new Error("No federation server found in stellar.toml");
  }

  // Make request to external federation server
  const federationUrl = `${federationServer}?q=${encodeURIComponent(query)}&type=${type}`;
  const response = await axios.get(federationUrl, { timeout: 5000 });

  return response.data;
}

/**
 * Parse FEDERATION_SERVER from stellar.toml content.
 * @param {string} tomlContent - The TOML content
 * @returns {string|null} The federation server URL or null
 */
function parseFederationServer(tomlContent) {
  // Simple TOML parsing for FEDERATION_SERVER
  const lines = tomlContent.split("\n");
  let inFederationServer = false;
  let server = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "[FEDERATION_SERVER]") {
      inFederationServer = true;
    } else if (inFederationServer && trimmed.startsWith("SERVER")) {
      const match = trimmed.match(/SERVER\s*=\s*"([^"]+)"/);
      if (match) {
        server = match[1];
        break;
      }
    } else if (inFederationServer && trimmed.startsWith("[")) {
      // End of section
      break;
    }
  }

  return server;
}

module.exports = {
  resolveFederation,
  clearFederationCache,
  invalidateFederationCache: clearFederationCache,
  resolveStellarAddress,
  resolveAccountId,
  forwardFederation,
};