/**
 * __tests__/errorEnvelope.test.js
 * #1422 — Return consistent error envelopes across all backend routes.
 *
 * Asserts the standard error envelope:
 * {
 *   "code": string,
 *   "message": string,
 *   "error": string,
 *   "details": any,
 *   "requestId": string
 * }
 * across route families, 404 handler, and AppError middleware.
 */

"use strict";

const request = require("supertest");
const jwt = require("jsonwebtoken");
const app = require("../src/server");
const { AppError, errorHandler, notFoundHandler, STATUS_TO_CODE } = require("../src/middleware/errorHandler");
const { JWT_SECRET } = require("../src/middleware/auth");

const TEST_SECRET = JWT_SECRET || process.env.JWT_SECRET || "test-secret-key-for-jest-tests-only-not-for-production";
const TEST_KEY = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function makeToken(publicKey = TEST_KEY) {
  return jwt.sign({ publicKey }, TEST_SECRET, { expiresIn: "1h" });
}

describe("Error Envelope Standard (#1422)", () => {
  describe("AppError and errorHandler middleware unit tests", () => {
    it("constructs AppError with expected status, message, code, and details", () => {
      const err = new AppError(422, "Invalid parameter", "UNPROCESSABLE_ENTITY", { field: "amount" });
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe("AppError");
      expect(err.status).toBe(422);
      expect(err.code).toBe("UNPROCESSABLE_ENTITY");
      expect(err.message).toBe("Invalid parameter");
      expect(err.details).toEqual({ field: "amount" });
    });

    it("derives default code from STATUS_TO_CODE when code is not supplied", () => {
      const err = new AppError(404, "Not found");
      expect(err.status).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.details).toBeNull();
    });

    it("errorHandler renders uniform envelope and sets X-Request-ID header", () => {
      const req = { headers: {}, get: () => null, log: { error: jest.fn() } };
      let sentStatus = null;
      let sentBody = null;
      const headers = {};
      const res = {
        status: (s) => {
          sentStatus = s;
          return res;
        },
        json: (b) => {
          sentBody = b;
          return res;
        },
        setHeader: (k, v) => {
          headers[k] = v;
        },
        getHeader: (k) => headers[k],
      };
      const next = jest.fn();

      const err = new AppError(400, "Validation failure", "VALIDATION_ERROR", { field: "username" });
      errorHandler(err, req, res, next);

      expect(sentStatus).toBe(400);
      expect(sentBody).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "Validation failure",
        error: "Validation failure",
        details: { field: "username" },
      });
      expect(typeof sentBody.requestId).toBe("string");
      expect(sentBody.requestId.length).toBeGreaterThan(0);
      expect(headers["X-Request-ID"]).toBe(sentBody.requestId);
    });
  });

  describe("404 Route Not Found envelope", () => {
    it("returns consistent envelope when requesting an undefined route", async () => {
      const res = await request(app).get("/api/non-existent-endpoint-12345");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: "NOT_FOUND",
        details: null,
      });
      expect(typeof res.body.message).toBe("string");
      expect(res.body.message).toContain("GET /api/non-existent-endpoint-12345");
      expect(res.body.error).toBe(res.body.message);
      expect(typeof res.body.requestId).toBe("string");
      expect(res.body.requestId.length).toBeGreaterThan(0);
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });

    it("preserves incoming X-Request-ID header in the error envelope", async () => {
      const customRequestId = "custom-req-id-uuid-987654321";
      const res = await request(app)
        .get("/api/another-missing-route")
        .set("X-Request-ID", customRequestId);

      expect(res.status).toBe(404);
      expect(res.body.requestId).toBe(customRequestId);
      expect(res.headers["x-request-id"]).toBe(customRequestId);
    });
  });

  describe("Auth route family error envelope", () => {
    it("GET /api/auth returns consistent envelope on missing account parameter", async () => {
      const res = await request(app).get("/api/auth");

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "BAD_REQUEST",
        message: "Missing account query parameter",
        error: "Missing account query parameter",
        details: null,
      });
      expect(typeof res.body.requestId).toBe("string");
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });

    it("POST /api/auth returns consistent envelope on missing transaction body", async () => {
      const res = await request(app).post("/api/auth").send({});

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "BAD_REQUEST",
        message: "Missing transaction in request body",
        error: "Missing transaction in request body",
        details: null,
      });
      expect(typeof res.body.requestId).toBe("string");
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });
  });

  describe("Contacts route family error envelope", () => {
    it("DELETE /api/contacts/:id returns 404 envelope when contact does not exist", async () => {
      const token = makeToken();
      const res = await request(app)
        .delete("/api/contacts/non-existent-contact-id")
        .set("Authorization", `Bearer ${token}`);

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: "NOT_FOUND",
        message: "Contact not found",
        error: "Contact not found",
        details: null,
      });
      expect(typeof res.body.requestId).toBe("string");
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });
  });

  describe("Tips route family error envelope", () => {
    it("PUT /api/tips/leaderboard/opt-out returns 400 envelope on invalid body", async () => {
      const token = makeToken();
      const res = await request(app)
        .put("/api/tips/leaderboard/opt-out")
        .set("Authorization", `Bearer ${token}`)
        .send({ optOut: "not-a-boolean" });

      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({
        code: "VALIDATION_ERROR",
        message: "optOut must be a boolean",
        error: "optOut must be a boolean",
        details: null,
      });
      expect(typeof res.body.requestId).toBe("string");
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });
  });

  describe("Webhooks route family error envelope", () => {
    it("DELETE /api/webhooks/:id returns 404 envelope when webhook not found", async () => {
      const res = await request(app).delete("/api/webhooks/non-existent-webhook-id");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: "NOT_FOUND",
        message: "Webhook not found",
        error: "Webhook not found",
        details: null,
      });
      expect(typeof res.body.requestId).toBe("string");
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });
  });

  describe("Turrets route family error envelope", () => {
    it("GET /api/turrets/:id returns 404 envelope when deployment not found", async () => {
      const res = await request(app).get("/api/turrets/00000000-0000-0000-0000-000000000000");

      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({
        code: "NOT_FOUND",
        error: "txFunction not found",
      });
      expect(typeof res.body.requestId).toBe("string");
      expect(res.headers["x-request-id"]).toBe(res.body.requestId);
    });
  });
});
