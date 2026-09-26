// Whatever your auth service returns, plus the resolved user identifier
// (extracted via AUTH_USER_ID_FIELD, see clients/authClient.ts).
interface AuthResponse {
  id: string | number;
  [key: string]: unknown;
}

export type { AuthResponse };
