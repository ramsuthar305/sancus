import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import http from 'http';
import https from 'https';
import ClientResponseStatus from '../types/requestStatus';
import { VeritasResponse } from '../types/veritas';

const veritasHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const veritasHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64 });

class VeritasServiceClient {
  private static instance: VeritasServiceClient;
  private readonly apiUrl: string;
  private readonly client: AxiosInstance;

  constructor() {
    this.apiUrl = process.env['VERITAS_URL']||"";
    this.client = axios.create({
      baseURL: this.apiUrl,
      httpAgent: veritasHttpAgent,
      httpsAgent: veritasHttpsAgent,
      timeout: 5000,
    });
  }

  static getInstance(): VeritasServiceClient {
    if (!VeritasServiceClient.instance) {
      VeritasServiceClient.instance = new VeritasServiceClient();
    }
    return VeritasServiceClient.instance;
  }

  // Function to make a request to the Veritas service
  async callVeritasService(
    token: string
  ): Promise<VeritasResponse | ClientResponseStatus> {
    try {
      const response: AxiosResponse<VeritasResponse> = await this.client.post(
        '/v1/verify/token',
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
