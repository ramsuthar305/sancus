type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'CONNECT' | 'TRACE';

interface APIAuthorization {
  methods: HttpMethod[];
}

interface APIRoute {
  path: string;
  methods: HttpMethod[];
  bypass?: string[];
  authorization?: APIAuthorization[];
}

interface API{
    name: string;
    description: string;
    routes: APIRoute[];
}

interface Service{
    name: string;
    host: string;
    port: number;
}

interface APIConfig {
  service: Service;
  apis: API[];
}

export type { APIConfig, APIRoute, APIAuthorization, API, HttpMethod,Service };