import express from "express";
import { getMyStatuses as getStatuses } from "./controller.js";
import missingHandler from "./controller.js";

const router = express.Router();

router.get("/mine", getStatuses);
router.get("/missing", missingHandler);

export default router;
