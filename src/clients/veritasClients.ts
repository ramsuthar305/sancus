import axios, { AxiosError, AxiosResponse } from 'axios';
import ClientResponseStatus from '../types/requestStatus';
import { VeritasResponse } from '../types/veritas';

class VeritasServiceClient {
  private readonly apiUrl: string;

  constructor() {
    // Pick the URL from an environment variable or provide a default
    this.apiUrl = process.env['VERITAS_URL']||"";
  }

  // Function to make a request to the Veritas service
  async callVeritasService(
    token: string
  ): Promise<VeritasResponse | ClientResponseStatus> {
    try {
      // Update url as per your auth apis
      const response: AxiosResponse<VeritasResponse> = await axios.post(
        `${this.apiUrl}/v1/verify/token`,
        { token }
      );

      // If the request is successful, return the payload info
      return response.data;
    } catch (error: any) {
      // Handle errors
      if (axios.isAxiosError(error)) {
        // Axios error
        const axiosError: AxiosError = error;

        if (axiosError.response) {
          const data: any = axiosError.response.data;
          if (data.message === 'Invalid Token')
            return ClientResponseStatus.UNAUTHORIZED;
        }

        // Check if the response status is 401 (Unauthorized)
        if (axiosError.response?.status === 401) {
          return ClientResponseStatus.UNAUTHORIZED;
        } else if (axiosError.response?.status === 400) {
          return ClientResponseStatus.BAD_REQUEST;
        } else {
          // Handle other errors
          console.error(
            'Request failed with status:',
            axiosError.response?.status
          );
          throw new Error('Request failed');
        }
      } else {
        // Handle non-Axios errors
        console.error('Non-Axios error:', error.message);
        throw new Error('Request failed');
      }
    }
  }
}

export default VeritasServiceClient;
