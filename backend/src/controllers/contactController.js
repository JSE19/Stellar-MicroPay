"use strict";

const contactService = require("../services/contactService");
const { AppError } = require("../middleware/errorHandler");

function owner(req) {
  return req.user.publicKey;
}

function list(req, res) {
  res.json({ success: true, data: contactService.listContacts(owner(req)) });
}

function create(req, res, next) {
  try {
    res.status(201).json({ success: true, data: contactService.createContact(owner(req), req.body) });
  } catch (error) {
    next(error);
  }
}

function remove(req, res, next) {
  const removed = contactService.removeContact(owner(req), req.params.id);
  if (!removed) return next(new AppError(404, "Contact not found", "NOT_FOUND"));
  return res.status(204).send();
}

module.exports = { list, create, remove };
