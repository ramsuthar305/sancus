interface GeoJsonFeature {
    type: string;
    geometry: {
        type: string;
        coordinates: any;
    };
    properties: {
        source: string;
        id: string;
        name: string;
    };
    id: number;
}

interface GeoJsonData {
    type: string;
    features: GeoJsonFeature[];
}

export type { GeoJsonData, GeoJsonFeature };