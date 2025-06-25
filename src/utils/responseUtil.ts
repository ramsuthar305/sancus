import ResponseEnum from "../types/responseEnums";
import { ResponseDetails } from "../types/responseDetails";
import { Response } from "express";

const ResponseEnumDetails: { [key in ResponseEnum]: ResponseDetails } = {
    [ResponseEnum.BAD_REQUEST]: { statusCode: 400, message: 'Bad Request', responseCode: 'SE0400' },
    [ResponseEnum.INTERNAL_SERVER_ERROR]: { statusCode: 500, message: 'Internal Server Error', responseCode: 'SE0500' },
    [ResponseEnum.DATABASE_ERROR]: { statusCode: 500, message: 'Database Error', responseCode: 'SE0600' },
    [ResponseEnum.CACHE_ERROR]: { statusCode: 500, message: 'Cache Error', responseCode: 'SE0700' },
    [ResponseEnum.NOT_FOUND]: { statusCode: 404, message: 'Resource not found', responseCode: 'SE0404' },
    [ResponseEnum.FORBIDDEN]: { statusCode: 403, message: "Resource can't be accessed by user", responseCode: 'SE0403' },
    [ResponseEnum.UNAUTHORIZED]: { statusCode: 401, message: 'Unauthorized', responseCode: 'SE0401' },
    [ResponseEnum.SUCCESS]: { statusCode: 200, message: 'Success', responseCode: 'SE0200' }, // Added a new response code for success
    [ResponseEnum.BANNED_TERRITORY]: { statusCode: 400, message: 'Request from banned territory', responseCode: 'SE0405' }, // New response code for banned territory
    [ResponseEnum.ALLOWED_TERRITORY]: { statusCode: 200, message: 'Allowed territory', responseCode: 'SS0200' }, // New response code for banned territory
    [ResponseEnum.COORDINATES_MISSING]: { statusCode: 400, message: 'Missing coordinates', responseCode: 'SE0406' }, // New response code for missing coordinates
    [ResponseEnum.INVALID_COORDINATES]: { statusCode: 400, message: 'Invalid Coordinates', responseCode: 'SE0407' } // New response code for invalid coordinates
};

class SancusResponse {
    constructor(responseType: ResponseEnum, data: any, res: Response) {
        const responseDetails = ResponseEnumDetails[responseType];

        const responseData: any = {
            message: responseDetails.message,
            response_code: responseDetails.responseCode
        };

        if (data) {
            responseData.data = data;
        }

        res.status(responseDetails.statusCode).json(responseData);
    }
}

export default SancusResponse;