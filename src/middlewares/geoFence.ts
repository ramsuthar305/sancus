import { Request, Response, NextFunction } from 'express';
import GeoUtils from '../utils/geoFenceUtil';
import SancusResponse from '../utils/responseUtil';
import ResponseEnum from '../types/responseEnums';
import getLogger from '../configs/logger';

const logger = getLogger();

const geoUtils = GeoUtils.getInstance('./in.json');

geoUtils.loadGeoJsonData().then(() => {
    logger.info('GeoJSON data loaded');
}).catch(err => {
    logger.error({ err }, 'Error loading GeoJSON data');
    process.exit(1);
});

export function geoFenceMiddleware(req: Request, res: Response, next: NextFunction): void {
    const coordinates = req.header('X-COORDINATES');
    if (req.method === 'OPTIONS') {
        next();
        return;
    }

    if (!coordinates) {
        new SancusResponse(ResponseEnum.COORDINATES_MISSING, {}, res);
        return;
    }

    const [lat, lon] = coordinates.split(',').map(Number);

    if (isNaN(lat) || isNaN(lon)) {
        new SancusResponse(ResponseEnum.INVALID_COORDINATES, {}, res);
        return;
    }

    geoUtils.findStateName(lat, lon)
        .then(stateName => {
            if (stateName) {
                new SancusResponse(ResponseEnum.BANNED_TERRITORY, {}, res);
            } else {
                next();
            }
        })
        .catch(err => {
            logger.error({ err }, 'Error finding state');
            res.status(500).json({ error: 'Internal server error.' });
        });
}
