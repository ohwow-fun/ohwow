/**
 * API Response Envelopes
 *
 * Standard response wrapper types for all API endpoints.
 */

/** Successful response envelope */
export interface ApiResponse<T> {
  success: true;
  data: T;
}

/** Error response envelope */
export interface ApiError {
  success: false;
  error: string;
  code?: string;
}

/** Union of success and error envelopes */
export type ApiResult<T> = ApiResponse<T> | ApiError;
