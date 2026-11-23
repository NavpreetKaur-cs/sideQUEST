import { Router } from "express";
import { getGoogleCallback, getGoogleUrl, getSession, login, logout, register } from "../controllers/authController.js";
import { issueCsrfToken } from "../middleware/csrf.js";
import { authenticate } from "../middleware/authenticate.js";
import { validateRequest } from "../middleware/validateRequest.js";
import { loginValidators, registerValidators } from "../validators/authValidators.js";

const router = Router();

router.get("/csrf", issueCsrfToken);
router.get("/google/url", getGoogleUrl);
router.get("/google/callback", getGoogleCallback);
router.post("/register", registerValidators, validateRequest, register);
router.post("/login", loginValidators, validateRequest, login);
router.post("/logout", authenticate, logout);
router.get("/me", authenticate, getSession);

export default router;