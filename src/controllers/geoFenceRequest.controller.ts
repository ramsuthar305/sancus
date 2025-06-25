import { Request, Response, NextFunction } from 'express';
import GeoUtils from '../utils/geoFenceUtil';
import SancusResponse from '../utils/responseUtil';
import ResponseEnum from '../types/responseEnums';

class GeoFenceRequestController {
    private geoUtils = GeoUtils.getInstance('./in.json');

    constructor() {
        this.geoFence = this.geoFence.bind(this);
    }

    public async geoFence(
        req: Request,
        res: Response,
        next: NextFunction
    ): Promise<Response | void> {
        const coordinates = req.header('X-COORDINATES');

        if (!coordinates) {
            new SancusResponse(ResponseEnum.COORDINATES_MISSING, {}, res);
            return;
        }

        const [lat, lon] = coordinates.split(',').map(Number);

        if (isNaN(lat) || isNaN(lon)) {
            new SancusResponse(ResponseEnum.INVALID_COORDINATES, {}, res);
            return;
        }

        this.geoUtils.findStateName(lat, lon)
            .then(stateName => {
                if (stateName) {
                    new SancusResponse(ResponseEnum.BANNED_TERRITORY, {}, res);
                    return;
                }
                new SancusResponse(ResponseEnum.ALLOWED_TERRITORY, {}, res);
            })
            .catch(err => {
                console.error('Error finding state:', err);
                new SancusResponse(ResponseEnum.INTERNAL_SERVER_ERROR, {}, res);
            });
    }
}

export default GeoFenceRequestController;