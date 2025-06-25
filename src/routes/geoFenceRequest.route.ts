import { Router } from "express";
import GeoFenceRequestController from "../controllers/geoFenceRequest.controller";
const controller = new GeoFenceRequestController();
const router = Router();

router.get("/check", controller.geoFence);

export default router;