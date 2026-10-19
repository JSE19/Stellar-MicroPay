"use strict";

const webhookService = require("../services/webhookService");
const { AppError } = require("../middleware/errorHandler");

function register(req, res, next) {
  try {
    const webhook = webhookService.register(req.body || {});
    res.status(201).json({ success: true, data: webhook });
  } catch (error) { next(error); }
}

function remove(req, res, next) {
  try {
    if (!webhookService.remove(req.params.id)) {
      return next(new AppError(404, "Webhook not found", "NOT_FOUND"));
    }
    return res.status(204).send();
  } catch (error) { return next(error); }
}

module.exports = { register, remove };
