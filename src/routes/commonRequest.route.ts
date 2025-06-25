import { Router } from 'express';
import CommonRequestController from '../controllers/commonRequest.controller';
const controller = new CommonRequestController();
const router = Router();

router.all('/*', controller.pipeline);

export default router;
