import { Request, Response, NextFunction } from 'express';
import GeoUtils from '../utils/geoFenceUtil';
import SancusResponse from '../utils/responseUtil';
import  ResponseEnum  from '../types/responseEnums';

const geoUtils = GeoUtils.getInstance('./in.json');

geoUtils.loadGeoJsonData().then(() => {
    console.log('GeoJSON data loaded successfully.');
}).catch(err => {
    console.error('Error loading GeoJSON data:', err);
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
            console.error('Error finding state:', err);
            res.status(500).json({ error: 'Internal server error.' });
        });
}
