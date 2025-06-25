interface VeritasResponse {
  id: number;
  user_data: Object;
  role: string;
  issued_at: number;
  expires_at: number;
  token_type: string;
}

export type {VeritasResponse}