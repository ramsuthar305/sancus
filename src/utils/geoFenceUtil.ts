import fs from 'fs';
import inside from 'point-in-polygon';
import { GeoJsonData } from '../types/geoJson';

class GeoUtils {
    private static instance: GeoUtils;
    private geoJsonFilePath: string;
    private geoJsonData: GeoJsonData | null;

    private constructor(geoJsonFilePath: string) {
        this.geoJsonFilePath = geoJsonFilePath;
        this.geoJsonData = null;
    }

    public static getInstance(geoJsonFilePath: string): GeoUtils {
        if (!GeoUtils.instance) {
            GeoUtils.instance = new GeoUtils(geoJsonFilePath);
        }
        return GeoUtils.instance;
    }

    // Function to load GeoJSON data into memory
    public loadGeoJsonData(): Promise<void> {
        return new Promise((resolve, reject) => {
            fs.readFile(this.geoJsonFilePath, 'utf8', (err, data) => {
                if (err) {
                    reject(err);
                } else {
                    try {
                        this.geoJsonData = JSON.parse(data) as GeoJsonData;
                        resolve();
                    } catch (parseError) {
                        reject(parseError);
                    }
                }
            });
        });
    }

    // Function to find state name from lat/lon
    public findStateName(lat: number, lon: number): Promise<string | null> {
        return new Promise((resolve, reject) => {
            if (!this.geoJsonData) {
                reject(new Error('GeoJSON data not loaded.'));
                return;
            }

            try {
                const features = this.geoJsonData.features;

                for (const feature of features) {
                    const geometry = feature.geometry;
                    if (geometry) {
                        const type = geometry.type;
                        const coordinates = geometry.coordinates;

                        if (type === 'Polygon') {
                            if (inside([lon, lat], coordinates[0])) {
                                resolve(feature.properties.name); 
                                return;
                            }
                        } else if (type === 'MultiPolygon') {
                            for (const polygon of coordinates) {
                                if (inside([lon, lat], polygon[0])) {
                                    resolve(feature.properties.name); 
                                    return;
                                }
                            }
                        }
                    }
                }

                resolve(null); // Return null if no state found (outside of all polygons)
            } catch (error) {
                reject(error);
            }
        });
    }
}

export default GeoUtils;
