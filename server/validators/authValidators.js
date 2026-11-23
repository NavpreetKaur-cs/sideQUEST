import { body } from "express-validator";

export const registerValidators = [
  body("username")
    .isString().withMessage("Username is required")
    .bail()
    .trim()
    .toLowerCase()
    .isLength({ min: 3, max: 24 }).withMessage("Username must be 3-24 characters")
    .matches(/^[a-z0-9_]+$/).withMessage("Use only letters, numbers, and underscores"),
  body("email")
    .isString().withMessage("Email is required")
    .bail()
    .trim()
    .toLowerCase()
    .isEmail().withMessage("Enter a valid email address")
    .isLength({ max: 254 }).withMessage("Email address is too long"),
  body("password")
    .isString().withMessage("Password is required")
    .bail()
    .isLength({ min: 8 }).withMessage("Password must be at least 8 characters")
    .bail()
    .custom((value) => Buffer.byteLength(value, "utf8") <= 72)
    .withMessage("Password must be no more than 72 bytes"),
];

export const loginValidators = [
  body("email")
    .isString().withMessage("Email is required")
    .bail()
    .trim()
    .toLowerCase()
    .isEmail().withMessage("Enter a valid email address"),
  body("password")
    .isString().withMessage("Password is required")
    .bail()
    .isLength({ min: 1 }).withMessage("Password is invalid")
    .bail()
    .custom((value) => Buffer.byteLength(value, "utf8") <= 72)
    .withMessage("Password is invalid")
];