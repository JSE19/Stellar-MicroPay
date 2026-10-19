/**
 * src/controllers/tipsController.js
 * Handles tip-related API requests.
 */

"use strict";

const tipsService = require("../services/tipsService");
const webhookService = require("../services/webhookService");
const { AppError } = require("../middleware/errorHandler");

/**
 * POST /api/tips
 * Record a new tip.
 */
async function recordTip(req, res, next) {
  try {
    const { senderPublicKey, creatorPublicKey, amount, asset, memo, txHash } = req.body;

    // Validate input
    tipsService.validateTipInput({ senderPublicKey, creatorPublicKey, amount });

    const tip = tipsService.recordTip({
      senderPublicKey,
      creatorPublicKey,
      amount,
      asset: asset || "XLM",
      memo: memo || "",
      txHash: txHash || "",
    });

    void webhookService.publishPayment(tip).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") console.error({ requestId: req.requestId, message: result.reason?.message || "Webhook delivery failed" });
      }
    });

    res.status(201).json({
      success: true,
      data: tip,
      message: "Tip recorded successfully",
    });
  } catch (err) {
    next(err);
  }
}

function getLeaderboard(req, res, next) {
  try {
    const data = tipsService.getLeaderboard();
    res.json({
      success: true,
      data: {
        ...data,
        topRecipients: data.recipients,
        topSenders: data.senders,
        totalTipped: data.totalXLM,
      },
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/tips/received/:creatorPublicKey
 * Get all tips received by a creator.
 */
async function getTipsReceived(req, res, next) {
  try {
    const { creatorPublicKey } = req.params;
    const { limit, offset } = req.query;

    const result = tipsService.getTipsReceived(creatorPublicKey, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    // Also get stats
    const stats = tipsService.getTipsStats(creatorPublicKey);

    res.json({
      success: true,
      data: {
        ...result,
        stats,
      },
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tips/stats/:creatorPublicKey
 * Get statistics for tips received by a creator.
 */
async function getTipsStats(req, res, next) {
  try {
    const { creatorPublicKey } = req.params;
    const stats = tipsService.getTipsStats(creatorPublicKey);
    res.json({
      success: true,
      data: stats,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tips/sent/:senderPublicKey
 * Get all tips sent by a user.
 */
async function getTipsSent(req, res, next) {
  try {
    const { senderPublicKey } = req.params;
    const { limit, offset } = req.query;

    const result = tipsService.getTipsSent(senderPublicKey, {
      limit: limit ? parseInt(limit, 10) : undefined,
      offset: offset ? parseInt(offset, 10) : undefined,
    });

    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tips/leaderboard/:creatorPublicKey
 * Get top tippers for a creator.
 */
async function getTopTippers(req, res, next) {
  try {
    const { creatorPublicKey } = req.params;
    const { limit } = req.query;
    
    const parsedLimit = limit ? parseInt(limit, 10) : 5;
    
    const result = tipsService.getTopTippers(creatorPublicKey, parsedLimit);
    
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tips/leaderboard
 * Get global leaderboard with top recipients and senders.
 */
async function getGlobalLeaderboard(req, res, next) {
  try {
    const result = tipsService.getGlobalLeaderboard();
    
    res.json({
      success: true,
      data: result,
    });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/tips/leaderboard/opt-out
 * The authenticated account's leaderboard visibility (#1511).
 */
function getLeaderboardOptOut(req, res, next) {
  try {
    res.json({ success: true, data: tipsService.getLeaderboardOptOut(req.user.publicKey) });
  } catch (err) {
    next(err);
  }
}

/**
 * PUT /api/tips/leaderboard/opt-out
 * Body: { optOut: boolean }. Applies only to the account in the JWT, so one
 * user can never hide or expose another (#1511).
 */
function setLeaderboardOptOut(req, res, next) {
  try {
    const { optOut } = req.body || {};
    if (typeof optOut !== "boolean") {
      return next(new AppError(400, "optOut must be a boolean", "VALIDATION_ERROR"));
    }
    const data = tipsService.setLeaderboardOptOut(req.user.publicKey, optOut);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  recordTip,
  getTipsReceived,
  getTipsStats,
  getTipsSent,
  getTopTippers,
  getLeaderboard,
  getGlobalLeaderboard,
  getLeaderboardOptOut,
  setLeaderboardOptOut,
};
